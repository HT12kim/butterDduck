// ...중복 선언 제거...

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const fs = require('fs'); // Added fs module
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;
const LIKES_FILE = path.join(__dirname, 'likes.json'); // Added LIKES_FILE

// Supabase setup
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Supabase 기반 Likes API
// GET: 모든 가게의 {storeId: likes} 반환
app.get('/api/likes', async (req, res) => {
    try {
        const { data, error } = await supabase.from('stores').select('id,likes');
        if (error) throw error;
        // { store_123: 5, ... } 형태로 변환
        const likesMap = {};
        data.forEach((store) => {
            likesMap['store_' + store.id] = typeof store.likes === 'number' ? store.likes : 0;
        });
        res.json(likesMap);
    } catch (e) {
        res.status(500).json({ error: 'Failed to read likes data from DB' });
    }
});

// POST: { id: 'store_123' } → 해당 store의 likes +1
app.post('/api/likes', async (req, res) => {
    try {
        const { id } = req.body;
        if (!id || !id.startsWith('store_')) return res.status(400).json({ error: 'Missing or invalid id' });
        const storeId = parseInt(id.replace('store_', ''), 10);
        if (isNaN(storeId)) return res.status(400).json({ error: 'Invalid store id' });

        // 현재 likes 값 조회
        const { data: store, error: fetchError } = await supabase
            .from('stores')
            .select('likes')
            .eq('id', storeId)
            .single();
        if (fetchError || !store) return res.status(404).json({ error: 'Store not found' });
        const newLikes = (store.likes || 0) + 1;

        // likes 값 업데이트
        const { error: updateError } = await supabase.from('stores').update({ likes: newLikes }).eq('id', storeId);
        if (updateError) throw updateError;

        res.json({ id, count: newLikes });
    } catch (e) {
        res.status(500).json({ error: 'Failed to update likes in DB' });
    }
});
if (!fs.existsSync(LIKES_FILE)) {
    fs.writeFileSync(LIKES_FILE, JSON.stringify({}));
}

// Helper to read/write likes
function getLikesData() {
    return JSON.parse(fs.readFileSync(LIKES_FILE, 'utf-8'));
}

function saveLikesData(data) {
    fs.writeFileSync(LIKES_FILE, JSON.stringify(data, null, 2));
}

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Helper function to get Geocoding from Naver Cloud Platform
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
            return {
                lat: parseFloat(addr.y),
                lng: parseFloat(addr.x),
            };
        }
    } catch (error) {
        console.error(`Geocoding failed for address: ${address}`, error.message);
    }
    return null;
}

// Enhanced API endpoint to proxy Naver Local Search API
app.get('/api/search', async (req, res) => {
    try {
        const { query } = req.query;

        if (!query) {
            return res.status(400).json({ error: 'Query parameter is required' });
        }

        // Search for multiple variations to find more stores
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

        // 확장된 카테고리 키워드 배열 (네이버 업종명 포함)
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

        // 검색어가 카페/디저트/커피 관련이면 카테고리 필터 완화
        const queryStr = (query || '').toLowerCase();
        const relaxCategory = allowedCategories.some((cat) => queryStr.includes(cat.toLowerCase()));

        let allItems = [];
        const seenAddresses = new Set();

        searchResponses.forEach((response) => {
            if (response.data.items) {
                response.data.items.forEach((item) => {
                    const cleanAddress = item.roadAddress || item.address;
                    const categoryStr = (item.category || '').toLowerCase();
                    const isAllowed = allowedCategories.some((cat) => categoryStr.includes(cat.toLowerCase()));
                    // relaxCategory가 true면 카테고리 무시하고 모두 포함, 아니면 기존 필터 적용
                    if ((relaxCategory || isAllowed) && !seenAddresses.has(cleanAddress)) {
                        seenAddresses.add(cleanAddress);
                        allItems.push(item);
                    }
                });
            }
        });

        console.log(`Found ${allItems.length} unique stores. Enriching with coordinates...`);

        // Enrich with coordinates using Geocoding (as requested)
        const enrichedItemsPromises = allItems.map(async (item) => {
            let lat = null;
            let lng = null;

            const coords = await getGeocoding(item.roadAddress || item.address);
            if (coords) {
                lat = coords.lat;
                lng = coords.lng;
            } else if (item.mapx && item.mapy) {
                // Fallback to Search API coordinates (scaled WGS84)
                lat = parseFloat(item.mapy) / 1e7;
                lng = parseFloat(item.mapx) / 1e7;
                console.log(`Using fallback coordinates for: ${item.title}`);
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

        // Add user-added stores from Supabase
        try {
            const { data: userStores, error } = await supabase.from('stores').select('*');

            if (error) {
                console.error('Supabase select error:', error);
            } else if (userStores) {
                userStores.forEach((store) => {
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

        res.json({ items: enrichedItems });
    } catch (error) {
        console.error('Error fetching data:', error.response ? error.response.data : error.message);
        res.status(500).json({ error: 'Failed to fetch or process search results' });
    }
});

// Endpoint to provide Maps API client ID securely to frontend
app.get('/api/config', (req, res) => {
    res.json({
        mapsClientId: process.env.NCP_CLIENT_ID,
    });
});

// Endpoint to add a new store
app.post('/api/add-store', async (req, res) => {
    console.log('POST /api/add-store called with:', req.body);
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Store name is required' });

    try {
        // Search using Naver Search API
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

            // Get coordinates
            let coords = await getGeocoding(address);
            if (!coords) {
                if (item.mapy && item.mapx) {
                    coords = {
                        lat: parseFloat(item.mapy) / 1e7,
                        lng: parseFloat(item.mapx) / 1e7,
                    };
                    console.warn('Geocoding failed, using Naver API coordinates for:', address, coords);
                } else {
                    coords = { lat: 37.5665, lng: 126.978 };
                    console.warn('Geocoding and Naver API coordinates both missing, using default for:', address);
                }
            }

            // Insert into Supabase
            console.log('Inserting into Supabase:', { name, address, lat: coords.lat, lng: coords.lng });
            const { data, error } = await supabase
                .from('stores')
                .insert([{ name, address, lat: coords.lat, lng: coords.lng }]);

            if (error) {
                console.error('Supabase insert error:', error);
                // 사용자 친화적 메시지
                return res
                    .status(500)
                    .json({ error: 'DB 저장에 실패했습니다. 이미 등록된 가게이거나, 서버에 문제가 있습니다.' });
            }
            console.log('Inserted successfully:', data);

            res.json({ success: true, store: data ? data[0] : null });
        } else {
            // 사용자 친화적 메시지
            res.status(404).json({ error: '디저트 가게 중에 검색결과가 없습니다. 가게명을 정확히 입력해 주세요.' });
        }
    } catch (error) {
        console.error('Error adding store:', error);
        // 네이버 API 인증 오류 등 상세 안내
        if (error.response && error.response.status === 401) {
            return res.status(500).json({ error: '네이버 API 인증에 실패했습니다. 관리자에게 문의해 주세요.' });
        }
        res.status(500).json({ error: '알 수 없는 오류로 등록에 실패했습니다. 잠시 후 다시 시도해 주세요.' });
    }
});

// Endpoint to get all stores
app.get('/api/stores', async (req, res) => {
    try {
        const { data, error } = await supabase.from('stores').select('*');

        if (error) throw error;
        res.json(data);
    } catch (error) {
        console.error('Error fetching stores:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
