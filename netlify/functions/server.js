const express = require('express');
const serverless = require('serverless-http');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const app = express();
const LIKES_FILE = '/tmp/likes.json'; // Netlify allows writing to /tmp in some environments, but for truly serverless, consider a DB.

// Ensure likes file exists in /tmp
if (!fs.existsSync(LIKES_FILE)) {
    fs.writeFileSync(LIKES_FILE, JSON.stringify({}));
}

function getLikesData() {
    try {
        return JSON.parse(fs.readFileSync(LIKES_FILE, 'utf-8'));
    } catch(e) { return {}; }
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
                'X-NCP-APIGW-API-KEY': process.env.NCP_CLIENT_SECRET
            }
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
        let allItems = [];
        const seenAddresses = new Set();

        searchResponses.forEach(response => {
            if (response.data.items) {
                response.data.items.forEach(item => {
                    const addr = item.roadAddress || item.address;
                    const isDessert = item.category && (
                        item.category.includes('카페') || 
                        item.category.includes('디저트') ||
                        item.category.includes('베이커리')
                    );
                    if (isDessert && !seenAddresses.has(addr)) {
                        seenAddresses.add(addr);
                        allItems.push(item);
                    }
                });
            }
        });

        const enrichedItemsResults = await Promise.all(allItems.map(async (item) => {
            const coords = await getGeocoding(item.roadAddress || item.address);
            if (coords) {
                return { ...item, lat: coords.lat, lng: coords.lng, title: item.title, address: item.roadAddress || item.address };
            }
            return null;
        }));

        res.json({ items: enrichedItemsResults.filter(i => i !== null) });
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

module.exports.handler = serverless(app);
