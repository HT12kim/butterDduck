const express = require('express');
const serverless = require('serverless-http');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

// Supabase 연동
const { createClient } = require('@supabase/supabase-js');
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const app = express();
const LIKES_FILE = '/tmp/likes.json'; // Netlify allows writing to /tmp in some environments, but for truly serverless, consider a DB.

// Ensure likes file exists in /tmp
if (!fs.existsSync(LIKES_FILE)) {
    fs.writeFileSync(LIKES_FILE, JSON.stringify({}));
}

function getLikesData() {
    try {
        return JSON.parse(fs.readFileSync(LIKES_FILE, 'utf-8'));
    } catch (e) {
        return {};
    }
}

function saveLikesData(data) {
    fs.writeFileSync(LIKES_FILE, JSON.stringify(data, null, 2));
}

app.use(express.json());

// Helper function to get Geocoding
async function getGeocoding(address) {
    try {
        const response = await axios.get('https://naveropenapi.apigw.ntruss.com/map-geocode/v2/geocode', {
            params: { query: address },
            headers: {
                'X-NCP-APIGW-API-KEY-ID': process.env.NCP_CLIENT_ID,
                'X-NCP-APIGW-API-KEY': process.env.NCP_CLIENT_SECRET,
            },
        });
        if (response.data.addresses && response.data.addresses.length > 0) {
            const addr = response.data.addresses[0];
            return { lat: parseFloat(addr.y), lng: parseFloat(addr.x) };
        }
    } catch (error) {
        console.error(`Geocoding failed for: ${address}`, error.message);
    }
    return null;
}

// API Routes
app.get('/api/search', async (req, res) => {
    try {
        const { query } = req.query;
        if (!query) return res.status(400).json({ error: 'Query required' });

        const queries = [query, `${query} 카페`, `${query} 맛집`];
        const searchPromises = queries.map((q) =>
            axios.get('https://openapi.naver.com/v1/search/local.json', {
                params: { query: q, display: 20 },
                headers: {
                    'X-Naver-Client-Id': process.env.NAVER_CLIENT_ID,
                    'X-Naver-Client-Secret': process.env.NAVER_CLIENT_SECRET,
                },
            }),
        );

        const searchResponses = await Promise.all(searchPromises);
        let allItems = [];
        const seenAddresses = new Set();

        searchResponses.forEach((response) => {
            if (response.data.items) {
                response.data.items.forEach((item) => {
                    const addr = item.roadAddress || item.address;
                    const isDessert =
                        item.category &&
                        (item.category.includes('카페') ||
                            item.category.includes('디저트') ||
                            item.category.includes('베이커리'));
                    if (isDessert && !seenAddresses.has(addr)) {
                        seenAddresses.add(addr);
                        allItems.push(item);
                    }
                });
            }
        });

        const enrichedItemsResults = await Promise.all(
            allItems.map(async (item) => {
                const coords = await getGeocoding(item.roadAddress || item.address);
                if (coords) {
                    return {
                        ...item,
                        lat: coords.lat,
                        lng: coords.lng,
                        title: item.title,
                        address: item.roadAddress || item.address,
                    };
                }
                return null;
            }),
        );

        res.json({ items: enrichedItemsResults.filter((i) => i !== null) });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/config', (req, res) => {
    res.json({ mapsClientId: process.env.NCP_CLIENT_ID });
});

app.get('/api/likes', (req, res) => {
    res.json(getLikesData());
});

app.post('/api/likes', (req, res) => {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'ID required' });
    const likes = getLikesData();
    likes[id] = (likes[id] || 0) + 1;
    saveLikesData(likes);
    res.json({ id, count: likes[id] });
});

// Netlify Functions용 가게 등록 API
app.post('/api/add-store', async (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Store name is required' });

    try {
        // Naver Search API로 가게 검색
        const searchResponse = await axios.get('https://openapi.naver.com/v1/search/local.json', {
            params: { query: `${name} 버터떡`, display: 5 },
            headers: {
                'X-Naver-Client-Id': process.env.NAVER_CLIENT_ID,
                'X-Naver-Client-Secret': process.env.NAVER_CLIENT_SECRET,
            },
        });

        if (searchResponse.data.items && searchResponse.data.items.length > 0) {
            const item = searchResponse.data.items[0];
            const address = item.roadAddress || item.address;

            // 좌표 변환
            let coords = await getGeocoding(address);
            if (!coords) {
                if (item.mapy && item.mapx) {
                    coords = {
                        lat: parseFloat(item.mapy) / 1e7,
                        lng: parseFloat(item.mapx) / 1e7,
                    };
                } else {
                    coords = { lat: 37.5665, lng: 126.978 };
                }
            }

            // Supabase에 저장
            const { data, error } = await supabase
                .from('stores')
                .insert([{ name, address, lat: coords.lat, lng: coords.lng }]);

            if (error) {
                return res
                    .status(500)
                    .json({ error: 'DB 저장에 실패했습니다. 이미 등록된 가게이거나, 서버에 문제가 있습니다.' });
            }

            res.json({ success: true, store: data ? data[0] : null });
        } else {
            res.status(404).json({ error: '디저트 가게 중에 검색결과가 없습니다. 가게명을 정확히 입력해 주세요.' });
        }
    } catch (error) {
        if (error.response && error.response.status === 401) {
            return res.status(500).json({ error: '네이버 API 인증에 실패했습니다. 관리자에게 문의해 주세요.' });
        }
        res.status(500).json({ error: '알 수 없는 오류로 등록에 실패했습니다. 잠시 후 다시 시도해 주세요.' });
    }
});

module.exports.handler = serverless(app);
