require('dotenv').config();
const express = require('express');
const serverless = require('serverless-http');
const axios = require('axios');

const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

const DEFAULT_KEYWORD = '버터떡';
const KAKAO_REST_KEY = process.env.KAKAO_REST_KEY;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const stripHtml = (text) => (text || '').replace(/<[^>]*>?/gm, '');

// Naver geocode helper for address-to-coordinates lookup
async function getGeocoding(address) {
    if (!address) return null;
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
        console.error(`Geocoding failed for ${address}:`, error.message);
    }
    return null;
}

// Kakao Local API search helper
async function kakaoKeywordSearch({ query, rect, x, y, page }) {
    if (!KAKAO_REST_KEY) throw new Error('KAKAO_REST_KEY missing');
    const params = { query, size: 15, page };
    if (rect) params.rect = rect;
    else if (x && y) {
        params.x = x;
        params.y = y;
        params.radius = 20000;
    }
    const { data } = await axios.get('https://dapi.kakao.com/v2/local/search/keyword.json', {
        params,
        headers: { Authorization: `KakaoAK ${KAKAO_REST_KEY}` },
    });
    return data.documents || [];
}

// ============================================================
// 검색 API: 지도 화면(bounds) 기반
// ============================================================
app.get('/api/search', async (req, res) => {
    try {
        const { query, lat, lng, swLat, swLng, neLat, neLng } = req.query;
        const keyword = (query || DEFAULT_KEYWORD).trim() || DEFAULT_KEYWORD;

        const centerLat = lat ? parseFloat(lat) : null;
        const centerLng = lng ? parseFloat(lng) : null;
        const bSwLat = swLat ? parseFloat(swLat) : null;
        const bSwLng = swLng ? parseFloat(swLng) : null;
        const bNeLat = neLat ? parseFloat(neLat) : null;
        const bNeLng = neLng ? parseFloat(neLng) : null;
        const hasBounds = [bSwLat, bSwLng, bNeLat, bNeLng].every((v) => Number.isFinite(v));
        const rect = hasBounds ? `${bSwLng},${bSwLat},${bNeLng},${bNeLat}` : null;

        const keywordPages = await Promise.allSettled([
            kakaoKeywordSearch({ query: keyword, rect, x: centerLng, y: centerLat, page: 1 }),
            kakaoKeywordSearch({ query: keyword, rect, x: centerLng, y: centerLat, page: 2 }),
            kakaoKeywordSearch({ query: keyword, rect, x: centerLng, y: centerLat, page: 3 }),
        ]);

        const documents = keywordPages
            .filter((r) => r.status === 'fulfilled')
            .flatMap((r) => r.value)
            .filter(Boolean);

        const seen = new Set();
        const seenAddresses = new Set();
        let enrichedItems = documents
            .map((doc) => {
                const lat = parseFloat(doc.y);
                const lng = parseFloat(doc.x);
                const address = doc.road_address_name || doc.address_name;
                const key = `${doc.place_name}|${address}`;
                if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
                if (seen.has(key)) return null;
                seen.add(key);
                return {
                    title: doc.place_name,
                    address,
                    lat,
                    lng,
                    category: doc.category_name,
                    link: doc.place_url,
                    phone: doc.phone,
                };
            })
            .filter(Boolean);

        if (hasBounds) {
            enrichedItems = enrichedItems.filter(
                (item) => item.lat >= bSwLat && item.lat <= bNeLat && item.lng >= bSwLng && item.lng <= bNeLng,
            );
        }

        try {
            const { data, error } = await supabase.from('stores').select('*');
            if (!error && data) {
                data.forEach((store) => {
                    const nameLower = (store.name || '').toLowerCase();
                    const addrLower = (store.address || '').toLowerCase();
                    const matchesKeyword =
                        nameLower.includes(keyword.toLowerCase()) || addrLower.includes(keyword.toLowerCase());

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
// 좋아요 API
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
        const { storeKey, title, address, lat, lng } = req.body;
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

        const cleanTitle = stripHtml(title) || '버터떡 매장';
        const numericLat = lat != null ? parseFloat(lat) : null;
        const numericLng = lng != null ? parseFloat(lng) : null;
        const hasCoords = Number.isFinite(numericLat) && Number.isFinite(numericLng);

        if (address && hasCoords) {
            try {
                const { data: existingStore, error: storeFetchErr } = await supabase
                    .from('stores')
                    .select('id')
                    .eq('address', address)
                    .maybeSingle();

                if (!storeFetchErr) {
                    if (!existingStore) {
                        await supabase
                            .from('stores')
                            .insert([{ name: cleanTitle, address, lat: numericLat, lng: numericLng, likes: newCount }]);
                    } else {
                        await supabase.from('stores').update({ likes: newCount }).eq('id', existingStore.id);
                    }
                }
            } catch (storeErr) {
                console.error('Failed to upsert store on like:', storeErr.message);
            }
        }

        res.json({ storeKey, count: newCount });
    } catch (e) {
        console.error('Like error:', e);
        res.status(500).json({ error: 'Failed to update like' });
    }
});

// 카카오 place_url 페이지에서 대표 이미지(frame_g) 추출 프록시
app.get('/api/place-image', async (req, res) => {
    try {
        const { url } = req.query;
        if (!url || !/^https?:\/\//.test(url)) return res.status(400).json({ error: 'invalid url' });
        if (!/kakao\.com/.test(url)) return res.status(400).json({ error: 'unsupported domain' });

        const { data } = await axios.get(url, {
            headers: {
                'User-Agent':
                    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
            },
        });
        const match = data.match(/<img[^>]*class="[^"]*frame_g[^"]*"[^>]*src="([^"]+)"/i);
        if (!match || !match[1]) return res.json({ imageUrl: null });
        res.json({ imageUrl: match[1] });
    } catch (e) {
        console.error('place-image error', e.message);
        res.json({ imageUrl: null });
    }
});

// ============================================================
// Config
// ============================================================
app.get('/api/config', (req, res) => {
    const kakaoJsKey = process.env.KAKAO_JS_KEY || process.env.KAKAO_JAVASCRIPT_KEY || '';
    res.json({ kakaoJsKey });
});

// ============================================================
// 가게 등록 API
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

        const pages = await Promise.allSettled([
            kakaoKeywordSearch({ query, page: 1 }),
            kakaoKeywordSearch({ query, page: 2 }),
        ]);

        const documents = pages
            .filter((r) => r.status === 'fulfilled')
            .flatMap((r) => r.value)
            .filter(Boolean);
        if (documents.length === 0) {
            return res.json({ items: [] });
        }

        const registeredAddresses = new Set();
        try {
            const { data } = await supabase.from('stores').select('address');
            if (data) {
                data.forEach((s) => {
                    if (s.address) registeredAddresses.add(s.address);
                });
            }
        } catch (_) {}

        const seen = new Set();
        const items = documents
            .map((doc) => {
                const address = doc.road_address_name || doc.address_name;
                const lat = parseFloat(doc.y);
                const lng = parseFloat(doc.x);
                const key = `${doc.place_name}|${address}`;
                if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
                if (!address || registeredAddresses.has(address)) return null;
                if (seen.has(key)) return null;
                seen.add(key);
                return {
                    title: stripHtml(doc.place_name),
                    address,
                    lat,
                    lng,
                    category: doc.category_name,
                    phone: doc.phone,
                    link: doc.place_url,
                };
            })
            .filter(Boolean);

        res.json({ items });
    } catch (error) {
        console.error('Search for register error:', error.message);
        res.status(500).json({ error: 'Failed to search places' });
    }
});

module.exports.handler = serverless(app);
