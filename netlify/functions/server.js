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

        // 검색 쿼리 변형
        const queries = [query, `${query} 카페`, `${query} 맛집`, `${query} 파는곳`];
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

        // 업종/상호명 필터 및 디버그 정보
        const allowedCategories = [
            '카페',
            '디저트',
            '빵집',
            '후식',
            '커피',
            '까페',
            '베이커리',
            '제과점',
            '브런치',
            '케이크',
            '샌드위치',
            '파티쉐',
            '디저트카페',
            'dessert',
            'cafe',
            'bakery',
            'patisserie',
            'brunch',
            'cake',
            'sandwich',
            '커피전문점',
            '음료',
            '음료점',
            'tea',
            'coffee',
            '커피숍',
        ];
        const franchiseKeywords = [
            '빽다방',
            '스타벅스',
            '이디야',
            '투썸',
            '메가커피',
            '할리스',
            '커피빈',
            '파스쿠찌',
            '컴포즈',
            '더벤티',
            '엔제리너스',
            '폴바셋',
            '탐앤탐스',
        ];
        const queryStr = (query || '').toLowerCase();
        const isFranchise = franchiseKeywords.some((kw) => queryStr.includes(kw.toLowerCase()));

        let allItems = [];
        const seenAddresses = new Set();
        let totalNaverItems = 0;
        searchResponses.forEach((response) => {
            if (response.data.items) totalNaverItems += response.data.items.length;
        });

        // 1차: 업종 필터 + 상호명 포함(프랜차이즈면 무시)
        searchResponses.forEach((response) => {
            if (response.data.items) {
                response.data.items.forEach((item) => {
                    const cleanAddress = item.roadAddress || item.address;
                    const categoryStr = (item.category || '').toLowerCase();
                    const titleStr = (item.title || '').replace(/<[^>]*>?/gm, '').toLowerCase();
                    const isAllowed = allowedCategories.some((cat) => categoryStr.includes(cat.toLowerCase()));
                    const isNameInTitleOrCategory = titleStr.includes(queryStr) || categoryStr.includes(queryStr);
                    if ((isFranchise || isAllowed || isNameInTitleOrCategory) && !seenAddresses.has(cleanAddress)) {
                        seenAddresses.add(cleanAddress);
                        allItems.push(item);
                    }
                });
            }
        });

        // 2차: 결과가 0개면 업종 필터 없이 한 번 더(중복 주소는 여전히 제거)
        if (allItems.length === 0) {
            searchResponses.forEach((response) => {
                if (response.data.items) {
                    response.data.items.forEach((item) => {
                        const cleanAddress = item.roadAddress || item.address;
                        if (!seenAddresses.has(cleanAddress)) {
                            seenAddresses.add(cleanAddress);
                            allItems.push(item);
                        }
                    });
                }
            });
        }

        // 좌표 변환
        const enrichedItemsPromises = allItems.map(async (item) => {
            let lat = null;
            let lng = null;
            const coords = await getGeocoding(item.roadAddress || item.address);
            if (coords) {
                lat = coords.lat;
                lng = coords.lng;
            } else if (item.mapx && item.mapy) {
                lat = parseFloat(item.mapy) / 1e7;
                lng = parseFloat(item.mapx) / 1e7;
            }
            if (lat && lng) {
                return {
                    title: item.title,
                    address: item.roadAddress || item.address,
                    lat: lat,
                    lng: lng,
                    category: item.category,
                    link: item.link,
                };
            }
            return null;
        });
        const enrichedItems = (await Promise.all(enrichedItemsPromises)).filter((item) => item !== null);

        // Supabase에서 사용자 등록 가게 추가
        let userStores = null;
        try {
            const { data, error } = await supabase.from('stores').select('*');
            if (error) {
                console.error('Supabase select error:', error);
            } else if (data) {
                userStores = data;
                data.forEach((store) => {
                    enrichedItems.push({
                        title: store.name,
                        address: store.address,
                        roadAddress: store.address,
                        lat: store.lat,
                        lng: store.lng,
                        category: '사용자 등록',
                        link: '',
                    });
                });
            }
        } catch (err) {
            console.error('Error fetching user stores:', err);
        }

        res.json({
            items: enrichedItems,
            _debug: {
                naverItems: totalNaverItems,
                filteredItems: allItems.length,
                enrichedItems: enrichedItems.length,
                supabaseUserStores: userStores ? userStores.length : null,
            },
        });
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
        // Check for duplicate stores in Supabase
        const { data: existingStores, error: checkError } = await supabase.from('stores').select('*').eq('name', name);

        if (checkError) {
            return res.status(500).json({ error: 'Error checking for duplicate stores.' });
        }

        if (existingStores && existingStores.length > 0) {
            return res.status(409).json({ error: 'This store is already registered.' });
        }

        // Proceed with registration if no duplicates found
        const { data, error } = await supabase.from('stores').insert([{ name }]);

        if (error) {
            return res.status(500).json({ error: 'Error registering the store.' });
        }

        res.json({ success: true, store: data[0] });
    } catch (error) {
        res.status(500).json({ error: 'Unexpected error occurred during registration.' });
    }
});

module.exports.handler = serverless(app);
