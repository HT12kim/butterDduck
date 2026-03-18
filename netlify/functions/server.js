const express = require('express');
const serverless = require('serverless-http');
const axios = require('axios');

const { createClient } = require('@supabase/supabase-js');
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const app = express();
app.use(express.json());

// Geocoding 헬퍼
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

// ============================================================
// 검색 API: 지도 화면(bounds) 기반으로 "버터떡" 키워드 포함 가게 검색
// ============================================================
app.get('/api/search', async (req, res) => {
    try {
        const { query, lat, lng, swLat, swLng, neLat, neLng } = req.query;
        if (!query) return res.status(400).json({ error: 'Query required' });

        const centerLat = lat ? parseFloat(lat) : null;
        const centerLng = lng ? parseFloat(lng) : null;
        const bSwLat = swLat ? parseFloat(swLat) : null;
        const bSwLng = swLng ? parseFloat(swLng) : null;
        const bNeLat = neLat ? parseFloat(neLat) : null;
        const bNeLng = neLng ? parseFloat(neLng) : null;
        const hasBounds = bSwLat !== null && bSwLng !== null && bNeLat !== null && bNeLng !== null;

        // 네이버 검색 쿼리 변형
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

        // 카테고리 / 프랜차이즈 필터
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

        searchResponses.forEach((response) => {
            if (response.data.items) {
                response.data.items.forEach((item) => {
                    const cleanAddress = item.roadAddress || item.address;
                    const categoryStr = (item.category || '').toLowerCase();
                    const titleStr = (item.title || '').replace(/<[^>]*>?/gm, '').toLowerCase();
                    const isAllowed = allowedCategories.some((cat) => categoryStr.includes(cat.toLowerCase()));
                    const isNameMatch = titleStr.includes(queryStr) || categoryStr.includes(queryStr);
                    if ((isFranchise || isAllowed || isNameMatch) && !seenAddresses.has(cleanAddress)) {
                        seenAddresses.add(cleanAddress);
                        allItems.push(item);
                    }
                });
            }
        });

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
        const enrichedPromises = allItems.map(async (item) => {
            let lat2 = null,
                lng2 = null;
            const coords = await getGeocoding(item.roadAddress || item.address);
            if (coords) {
                lat2 = coords.lat;
                lng2 = coords.lng;
            } else if (item.mapx && item.mapy) {
                lat2 = parseFloat(item.mapy) / 1e7;
                lng2 = parseFloat(item.mapx) / 1e7;
            }
            if (lat2 && lng2) {
                return {
                    title: item.title,
                    address: item.roadAddress || item.address,
                    lat: lat2,
                    lng: lng2,
                    category: item.category,
                    link: item.link,
                };
            }
            return null;
        });
        let enrichedItems = (await Promise.all(enrichedPromises)).filter(Boolean);

        // bounds 필터링
        if (hasBounds) {
            enrichedItems = enrichedItems.filter(
                (item) => item.lat >= bSwLat && item.lat <= bNeLat && item.lng >= bSwLng && item.lng <= bNeLng,
            );
        }

        // Supabase 사용자 등록 가게도 추가 (bounds 내만)
        try {
            const { data, error } = await supabase.from('stores').select('*');
            if (!error && data) {
                data.forEach((store) => {
                    if (hasBounds) {
                        if (store.lat < bSwLat || store.lat > bNeLat || store.lng < bSwLng || store.lng > bNeLng)
                            return;
                    }
                    if (!seenAddresses.has(store.address)) {
                        seenAddresses.add(store.address);
                        enrichedItems.push({
                            title: store.name,
                            address: store.address,
                            lat: store.lat,
                            lng: store.lng,
                            category: '사용자 등록',
                            link: '',
                        });
                    }
                });
            }
        } catch (err) {
            console.error('Error fetching user stores:', err);
        }

        // 중심 좌표 기준 거리 계산
        if (centerLat !== null && centerLng !== null) {
            enrichedItems.forEach((item) => {
                const R = 6371;
                const dLat = ((item.lat - centerLat) * Math.PI) / 180;
                const dLng = ((item.lng - centerLng) * Math.PI) / 180;
                const a =
                    Math.sin(dLat / 2) ** 2 +
                    Math.cos((centerLat * Math.PI) / 180) *
                        Math.cos((item.lat * Math.PI) / 180) *
                        Math.sin(dLng / 2) ** 2;
                item.distanceKm = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
            });
            enrichedItems.sort((a, b) => a.distanceKm - b.distanceKm);
        }

        res.json({ items: enrichedItems });
    } catch (error) {
        console.error('Search error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// 좋아요 API: Supabase likes 테이블 기반
// ============================================================
app.get('/api/likes', async (req, res) => {
    try {
        const { data, error } = await supabase.from('likes').select('store_key, count');
        if (error) throw error;
        const likesMap = {};
        (data || []).forEach((row) => {
            likesMap[row.store_key] = row.count || 0;
        });
        res.json(likesMap);
    } catch (e) {
        // fallback: stores 테이블
        try {
            const { data } = await supabase.from('stores').select('id, likes');
            const likesMap = {};
            (data || []).forEach((s) => {
                likesMap['store_' + s.id] = s.likes || 0;
            });
            res.json(likesMap);
        } catch (_) {
            res.json({});
        }
    }
});

app.post('/api/likes', async (req, res) => {
    try {
        const { storeKey } = req.body;
        if (!storeKey) return res.status(400).json({ error: 'storeKey required' });

        const { data: existing, error: fetchErr } = await supabase
            .from('likes')
            .select('*')
            .eq('store_key', storeKey)
            .maybeSingle();
        if (fetchErr) throw fetchErr;

        let newCount;
        if (existing) {
            newCount = (existing.count || 0) + 1;
            await supabase.from('likes').update({ count: newCount }).eq('store_key', storeKey);
        } else {
            newCount = 1;
            await supabase.from('likes').insert([{ store_key: storeKey, count: 1 }]);
        }
        res.json({ storeKey, count: newCount });
    } catch (e) {
        console.error('Like error:', e);
        res.status(500).json({ error: 'Failed to update like' });
    }
});

// ============================================================
// Config
// ============================================================
app.get('/api/config', (req, res) => {
    res.json({ mapsClientId: process.env.NCP_CLIENT_ID });
});

// ============================================================
// 가게 등록 API: 주소 기준 중복 방지
// ============================================================
app.post('/api/add-store', async (req, res) => {
    const { name, address, lat, lng } = req.body;
    if (!name || !address || !lat || !lng) {
        return res.status(400).json({ error: '가게 이름, 주소, 좌표가 필요합니다.' });
    }
    try {
        const { data: exists } = await supabase.from('stores').select('id').eq('address', address);
        if (exists && exists.length > 0) {
            return res.status(409).json({ error: '이미 등록된 가게입니다.' });
        }
        const { data, error } = await supabase.from('stores').insert([{ name, address, lat, lng }]);
        if (error) return res.status(500).json({ error: 'DB 저장 실패' });
        res.json({ success: true, store: data ? data[0] : null });
    } catch (error) {
        console.error('Add store error:', error);
        res.status(500).json({ error: '등록 실패' });
    }
});

// ============================================================
// 등록용 검색 API: 이미 등록된 가게 제외
// ============================================================
app.get('/api/search-for-register', async (req, res) => {
    try {
        const { query } = req.query;
        if (!query) return res.status(400).json({ error: 'Query required' });

        const response = await axios.get('https://openapi.naver.com/v1/search/local.json', {
            params: { query, display: 20 },
            headers: {
                'X-Naver-Client-Id': process.env.NAVER_CLIENT_ID,
                'X-Naver-Client-Secret': process.env.NAVER_CLIENT_SECRET,
            },
        });
        if (!response.data.items || response.data.items.length === 0) {
            return res.json({ items: [] });
        }

        // 이미 등록된 주소 목록
        let registeredAddresses = new Set();
        try {
            const { data } = await supabase.from('stores').select('address');
            if (data)
                data.forEach((s) => {
                    if (s.address) registeredAddresses.add(s.address);
                });
        } catch (_) {}

        const resultPromises = response.data.items.map(async (item) => {
            const addr = item.roadAddress || item.address;
            if (registeredAddresses.has(addr)) return null;
            let lat2 = null,
                lng2 = null;
            const coords = await getGeocoding(addr);
            if (coords) {
                lat2 = coords.lat;
                lng2 = coords.lng;
            } else if (item.mapx && item.mapy) {
                lat2 = parseFloat(item.mapy) / 1e7;
                lng2 = parseFloat(item.mapx) / 1e7;
            }
            if (lat2 && lng2) {
                return {
                    title: (item.title || '').replace(/<[^>]*>?/gm, ''),
                    address: addr,
                    lat: lat2,
                    lng: lng2,
                    category: item.category,
                };
            }
            return null;
        });
        const items = (await Promise.all(resultPromises)).filter(Boolean);
        res.json({ items });
    } catch (error) {
        console.error('Search for register error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

module.exports.handler = serverless(app);
