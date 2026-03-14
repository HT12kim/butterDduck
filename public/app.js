let map;
let markers = [];
let infoWindow;

// 하드코딩된 위치 주석 처리 (웹 배포용으로 실제 위치 수신 사용)
/*
const DEFAULT_LAT = 37.5547;
const DEFAULT_LNG = 126.9706;
*/

let currentLat = 37.5665; // 기본값 (서울 시청)
let currentLng = 126.9780;
let storeLikes = {}; // 전역 변수 선언 누락 수정

function setupMobileUI() {
    const listBtn = document.getElementById('list-toggle-btn');
    const infoPanel = document.getElementById('info-panel');
    
    if (listBtn) {
        listBtn.onclick = () => {
            infoPanel.classList.toggle('open');
            listBtn.innerHTML = infoPanel.classList.contains('open') ? 
                '<span class="btn-icon">🗺️</span> 지도보기' : 
                '<span class="btn-icon">📋</span> 목록보기';
        };
    }

    const myLocBtn = document.getElementById('my-location-btn');
    if (myLocBtn) {
        myLocBtn.onclick = () => {
            if (map) {
                map.panTo(new naver.maps.LatLng(currentLat, currentLng));
            }
        };
    }
}

async function initApp() {
    setupMobileUI();
    let initTimeout;

    try {
        // 1. Get Client ID from our backend
        const configResponse = await fetch('/api/config');
        const config = await configResponse.json();
        
        if (!config.mapsClientId) {
            alert('Naver Maps Client ID가 설정되지 않았습니다. .env 파일을 확인해주세요.');
            return;
        }

        // 2. Load Naver Maps Script
        await loadNaverMapsScript(config.mapsClientId);

        // 3. Initialize InfoWindow after Maps API is loaded
        infoWindow = new naver.maps.InfoWindow({ anchorSkew: true });

        // 4. Geolocation API를 사용하여 현재 위치 수신 시도
        // 8초 후에도 응답이 없으면 기본 위치로 시작하는 안전 장치
        let isInitialized = false;
        initTimeout = setTimeout(() => {
            if (!isInitialized) {
                console.warn("Geolocation timed out. Initializing with default location.");
                isInitialized = true;
                initializeMap(currentLat, currentLng);
            }
        }, 8000);

        if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition(
                (position) => {
                    if (isInitialized) return;
                    isInitialized = true;
                    clearTimeout(initTimeout);
                    currentLat = position.coords.latitude;
                    currentLng = position.coords.longitude;
                    initializeMap(currentLat, currentLng);
                },
                (error) => {
                    if (isInitialized) return;
                    isInitialized = true;
                    clearTimeout(initTimeout);
                    console.warn("Geolocation failed or denied. Using default Seoul center.", error);
                    initializeMap(currentLat, currentLng);
                },
                { timeout: 5000, enableHighAccuracy: true }
            );
        } else {
            isInitialized = true;
            clearTimeout(initTimeout);
            console.warn("Browser doesn't support geolocation.");
            initializeMap(currentLat, currentLng);
        }

    } catch (error) {
        console.error('Initialization error:', error);
        // 에러 발생 시에도 로딩 오버레이는 제거 시도
        const overlay = document.getElementById('loading-overlay');
        if (overlay) overlay.style.display = 'none';
    }
}

function loadNaverMapsScript(clientId) {
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        // NCP Maps API 업데이트된 엔드포인트 사용 (ncpKeyId 파라미터)
        script.src = `https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=${clientId}`;
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
    });
}

function initializeMap(lat, lng) {
    const mapOptions = {
        center: new naver.maps.LatLng(lat, lng),
        zoom: 14,
        minZoom: 10,
        mapTypeControl: false,
        zoomControl: false,
        zoomControlOptions: {
            position: naver.maps.Position.RIGHT_BOTTOM
        }
    };

    map = new naver.maps.Map('map', mapOptions);

    // Custom "My Location" marker with pulse effect
    const myLocationContent = `
        <div class="my-location-marker">
            <div class="pulse"></div>
            <div class="dot"></div>
        </div>
        <div style="
            margin-top: 4px;
            background: #4A90D9;
            color: white;
            font-size: 11px;
            font-weight: bold;
            font-family: 'Noto Sans KR', sans-serif;
            padding: 2px 8px;
            border-radius: 10px;
            white-space: nowrap;
            box-shadow: 0 1px 4px rgba(0,0,0,0.2);
        ">📍 내 위치</div>
        <style>
            @keyframes pulse {
                0% { box-shadow: 0 0 0 0 rgba(74,144,217,0.5); }
                70% { box-shadow: 0 0 0 12px rgba(74,144,217,0); }
                100% { box-shadow: 0 0 0 0 rgba(74,144,217,0); }
            }
        </style>
    `;

    new naver.maps.Marker({
        position: new naver.maps.LatLng(currentLat, currentLng),
        map: map,
        icon: {
            content: myLocationContent,
            anchor: new naver.maps.Point(22, 22)
        },
        title: '내 위치',
        zIndex: 1000
    });

    // 10km Search Radius Circle
    new naver.maps.Circle({
        map: map,
        center: new naver.maps.LatLng(lat, lng),
        radius: 10000, // 10km
        fillColor: '#FFD93D',
        fillOpacity: 0.1,
        strokeColor: '#FF8B13',
        strokeOpacity: 0.3,
        strokeWeight: 2,
        clickable: false,
        zIndex: 1
    });

    document.getElementById('loading-overlay').style.opacity = '0';
    setTimeout(() => {
        document.getElementById('loading-overlay').style.display = 'none';
    }, 300);

    searchPlaces('버터떡', lat, lng);

    // Re-search when map is dragged
    naver.maps.Event.addListener(map, 'idle', () => {
        const center = map.getCenter();
        searchPlaces('버터떡', center.lat(), center.lng());
    });
}

// Haversine 공식으로 두 좌표 사이의 거리(km) 계산
function getDistanceKm(lat1, lng1, lat2, lng2) {
    const R = 6371; // 지구 반지름 (km)
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function searchPlaces(query, lat, lng) {
    try {
        // 백엔드에 현재 위경도를 전달하여 주변 검색 유도
        const response = await fetch(`/api/search?query=${encodeURIComponent(query)}&lat=${lat}&lng=${lng}`);
        const data = await response.json();

        if (data.items) {
            // 현재 위치로부터 10km 이내 가게만 필터링
            const RADIUS_KM = 10;
            const filtered = data.items
                .map(item => {
                    const dist = getDistanceKm(lat, lng, item.lat, item.lng);
                    return { ...item, distanceKm: dist };
                })
                .filter(item => item.distanceKm <= RADIUS_KM)
                .sort((a, b) => a.distanceKm - b.distanceKm);

            displayPlaces(filtered);
            updateMarkers(filtered);
        }
    } catch (error) {
        console.error('Search error:', error);
    }
}

function displayPlaces(items) {
    const listContainer = document.getElementById('places-list');
    const resultCount = document.getElementById('result-count');
    
    resultCount.textContent = items.length;
    
    if (items.length === 0) {
        listContainer.innerHTML = '<p class="empty-msg">검색 결과가 없습니다.</p>';
        return;
    }

    listContainer.innerHTML = '';
    items.forEach((item, index) => {
        const div = document.createElement('div');
        div.className = 'place-item';
        div.innerHTML = `
            <span class="category">${item.category}</span>
            <h3>${item.title.replace(/<[^>]*>?/gm, '')}</h3>
            <p class="address">${item.roadAddress || item.address}</p>
            <p class="distance">📍 ${item.distanceKm < 1 ? (item.distanceKm * 1000).toFixed(0) + 'm' : item.distanceKm.toFixed(2) + 'km'} (내 위치 기준)</p>
        `;
        div.onclick = () => {
            if (!map || typeof naver === 'undefined') return;
            const latlng = new naver.maps.LatLng(item.lat, item.lng);
            map.panTo(latlng);
            showInfoWindow(markers[index], item);
        };
        listContainer.appendChild(div);
    });
}

// Simple hash function for unique store ID
function getStoreId(item) {
    const str = (item.title + item.address).replace(/\s+/g, '');
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i);
        hash |= 0;
    }
    return 'store_' + Math.abs(hash);
}

async function fetchLikes() {
    try {
        const res = await fetch('/api/likes');
        storeLikes = await res.json();
    } catch (e) {
        console.error('Failed to fetch likes', e);
    }
}

async function handleLike(storeId, badgeEl) {
    const likedStores = JSON.parse(localStorage.getItem('liked_stores') || '{}');
    if (likedStores[storeId]) {
        alert('이미 "좋아요"를 누른 가게입니다! 🥰');
        return;
    }

    try {
        const res = await fetch('/api/likes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: storeId })
        });
        const data = await res.json();
        
        // Update local state and UI
        storeLikes[storeId] = data.count;
        if (badgeEl) {
            badgeEl.innerText = data.count;
            badgeEl.classList.add('bump');
            setTimeout(() => badgeEl.classList.remove('bump'), 400);
        }
        
        // Save to localStorage to prevent multiple likes
        likedStores[storeId] = true;
        localStorage.setItem('liked_stores', JSON.stringify(likedStores));
    } catch (e) {
        console.error('Like failed', e);
    }
}

async function updateMarkers(items) {
    markers.forEach(m => m.setMap(null));
    markers = [];

    await fetchLikes();

    items.forEach((item, index) => {
        const storeId = getStoreId(item);
        const likeCount = storeLikes[storeId] || 0;

        // Create Custom HTML Content for Marker
        const markerContent = `
            <div class="custom-marker" id="marker-${storeId}">
                <img src="./image.png" class="marker-img" alt="butter tteok">
                ${likeCount > 0 ? `<div class="like-badge">${likeCount}</div>` : ''}
            </div>
        `;

        const marker = new naver.maps.Marker({
            position: new naver.maps.LatLng(item.lat, item.lng),
            map: map,
            icon: {
                content: markerContent,
                size: new naver.maps.Size(44, 44),
                anchor: new naver.maps.Point(22, 22)
            }
        });

        // Add both InfoWindow logic and Like logic
        naver.maps.Event.addListener(marker, 'click', (e) => {
            // Check if clicking the image directly for "Like"
            const target = e.domEvent.target;
            if (target.tagName === 'IMG') {
                let badgeEl = document.querySelector(`#marker-${storeId} .like-badge`);
                // If badge doesn't exist yet but it's the first like, we need to create it
                if (!badgeEl) {
                    const container = document.getElementById(`marker-${storeId}`);
                    if (container) { // Ensure container exists before appending
                        badgeEl = document.createElement('div');
                        badgeEl.className = 'like-badge';
                        badgeEl.innerText = '0'; // Will be updated by handleLike
                        container.appendChild(badgeEl);
                    }
                }
                handleLike(storeId, badgeEl);
            } else {
                showInfoWindow(marker, item);
            }
        });

        markers.push(marker);
    });
}

function showInfoWindow(marker, item) {
    const content = `
        <div style="padding:15px; min-width:200px; font-family: 'Noto Sans KR', sans-serif;">
            <h4 style="margin:0 0 5px 0; color:#333;">${item.title.replace(/<[^>]*>?/gm, '')}</h4>
            <p style="margin:0; font-size:12px; color:#666;">${item.roadAddress || item.address}</p>
            <a href="https://search.naver.com/search.naver?query=${encodeURIComponent(item.title.replace(/<[^>]*>?/gm, ''))}" 
               target="_blank" 
               style="display:inline-block; margin-top:8px; font-size:12px; color:#ccac00; text-decoration:none; font-weight:bold;">
               상세보기 →
            </a>
        </div>
    `;
    infoWindow.setContent(content);
    infoWindow.open(map, marker);
}

document.addEventListener('DOMContentLoaded', initApp);
