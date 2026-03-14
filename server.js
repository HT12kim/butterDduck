require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const fs = require('fs'); // Added fs module

const app = express();
const PORT = process.env.PORT || 3000;
const LIKES_FILE = path.join(__dirname, 'likes.json'); // Added LIKES_FILE

// Ensure likes file exists
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
                'X-NCP-APIGW-API-KEY': process.env.NCP_CLIENT_SECRET
            }
        });

        if (response.data.addresses && response.data.addresses.length > 0) {
            const addr = response.data.addresses[0];
            return {
                lat: parseFloat(addr.y),
                lng: parseFloat(addr.x)
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
        const queries = [
            query, 
            `${query} 카페`, 
            `${query} 맛집`
        ];
        const searchPromises = queries.map(q => 
            axios.get('https://openapi.naver.com/v1/search/local.json', {
                params: { query: q, display: 20 },
                headers: {
                    'X-Naver-Client-Id': process.env.SEARCH_CLIENT_ID,
                    'X-Naver-Client-Secret': process.env.SEARCH_CLIENT_SECRET
                }
            })
        );

        const searchResponses = await Promise.all(searchPromises);
        
        // Flatten and deduplicate results by address
        let allItems = [];
        const seenAddresses = new Set();

        searchResponses.forEach(response => {
            if (response.data.items) {
                response.data.items.forEach(item => {
                    const cleanAddress = item.roadAddress || item.address;
                    // '카페' 또는 '디저트' 또는 '베이커리'가 포함된 카테고리만 필터링
                    const isDessert = item.category && (
                        item.category.includes('카페') || 
                        item.category.includes('디저트') ||
                        item.category.includes('베이커리')
                    );

                    if (isDessert && !seenAddresses.has(cleanAddress)) {
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
                    link: item.link
                };
            }
            return null;
        });

        const enrichedItems = (await Promise.all(enrichedItemsPromises)).filter(item => item !== null);

        res.json({ items: enrichedItems });
    } catch (error) {
        console.error('Error fetching data:', error.response ? error.response.data : error.message);
        res.status(500).json({ error: 'Failed to fetch or process search results' });
    }
});

// Endpoint to provide Maps API client ID securely to frontend
app.get('/api/config', (req, res) => {
    res.json({
        mapsClientId: process.env.NCP_CLIENT_ID
    });
});

// Endpoint to get all likes
app.get('/api/likes', (req, res) => {
    res.json(getLikesData());
});

// Endpoint to increment like
app.post('/api/likes', (req, res) => {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'ID is required' });

    const likes = getLikesData();
    likes[id] = (likes[id] || 0) + 1;
    saveLikesData(likes);
    
    res.json({ id, count: likes[id] });
});

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
