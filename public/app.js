let map;
let markers = [];
let infoWindow;

// 하드코딩된 위치 주석 처리 (웹 배포용으로 실제 위치 수신 사용)
/*
const DEFAULT_LAT = 37.5547;
const DEFAULT_LNG = 126.9706;
*/

let currentLat = 37.5665; // 기본값 (서울 시청)
let currentLng = 126.978;
let storeLikes = {};

function setupMobileUI() {
    const listBtn = document.getElementById('list-toggle-btn');
    const infoPanel = document.getElementById('info-panel');

    if (listBtn) {
        listBtn.onclick = () => {
            infoPanel.classList.toggle('open');
            listBtn.innerHTML = infoPanel.classList.contains('open')
                ? '<span class="btn-icon">🗺️</span> 지도보기'
                : '<span class="btn-icon">📋</span> 목록보기';
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

    const addStoreBtn = document.getElementById('add-store-btn');
    if (addStoreBtn) {
        addStoreBtn.onclick = () => {
            showAddStoreModal();
        };
    }
}

async function initApp() {
    console.log('initApp started');
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
        console.log('Naver Maps script loaded');

        // 4. Initialize InfoWindow after Maps API is loaded
        infoWindow = new naver.maps.InfoWindow({ anchorSkew: true });

        // 4. Geolocation API를 사용하여 현재 위치 수신 시도
        // 8초 후에도 응답이 없으면 기본 위치로 시작하는 안전 장치
        let isInitialized = false;
        initTimeout = setTimeout(() => {
            if (!isInitialized) {
                console.warn('Geolocation timed out. Initializing with default location.');
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
                    console.warn('Geolocation failed or denied. Using default Seoul center.', error);
                    initializeMap(currentLat, currentLng);
                },
                { timeout: 5000, enableHighAccuracy: true },
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
    console.log('initializeMap called with', lat, lng);
    const mapOptions = {
        center: new naver.maps.LatLng(lat, lng),
        zoom: 14,
        minZoom: 10,
        mapTypeControl: false,
        zoomControl: false,
        zoomControlOptions: {
            position: naver.maps.Position.RIGHT_BOTTOM,
        },
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
            anchor: new naver.maps.Point(22, 22),
        },
        title: '내 위치',
        zIndex: 1000,
    });

    // 5km Search Radius Circle (Background)
    new naver.maps.Circle({
        map: map,
        center: new naver.maps.LatLng(lat, lng),
        radius: 5000, // 5km
        fillColor: '#4A90D9',
        fillOpacity: 0.05,
        strokeColor: '#007AFF',
        strokeOpacity: 0.2,
        strokeWeight: 1,
        clickable: false,
        zIndex: 1,
    });

    // Always hide loading overlay
    const hideOverlay = () => {
        const overlay = document.getElementById('loading-overlay');
        if (overlay) {
            overlay.style.opacity = '0';
            setTimeout(() => {
                overlay.style.display = 'none';
            }, 300);
        }
    };
    hideOverlay();

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
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLng = ((lng2 - lng1) * Math.PI) / 180;
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function searchPlaces(query, lat, lng) {
    try {
        console.log('[DEBUG] searchPlaces 호출:', query, lat, lng); // Log function call
        const response = await fetch(`/api/search?query=${encodeURIComponent(query)}&lat=${lat}&lng=${lng}`);
        const data = await response.json();
        console.log('[DEBUG] API 응답 데이터:', data); // Log API response

        if (data.items) {
            const RADIUS_KM = 5;
            const filtered = data.items
                .map((item) => {
                    const dist = getDistanceKm(lat, lng, item.lat, item.lng);
                    return { ...item, distanceKm: dist };
                })
                .filter((item) => item.distanceKm <= RADIUS_KM)
                .sort((a, b) => a.distanceKm - b.distanceKm);

            console.log('[DEBUG] 필터링된 데이터:', filtered); // Log filtered results
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
        listContainer.innerHTML = '<p class="empty-msg">디저트 가게 중에 검색결과가 없습니다.</p>';
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
            <p class="distance">📍 ${
                item.distanceKm < 1 ? (item.distanceKm * 1000).toFixed(0) + 'm' : item.distanceKm.toFixed(2) + 'km'
            } (내 위치 기준)</p>
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
        hash = (hash << 5) - hash + str.charCodeAt(i);
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
            body: JSON.stringify({ id: storeId }),
        });
        const data = await res.json();

        // Update local state and UI
        const count = typeof data.count === 'number' && !isNaN(data.count) ? data.count : 0;
        storeLikes[storeId] = count;
        if (badgeEl) {
            badgeEl.innerText = count;
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
    // 마커 깜빡임 방지: 기존 마커 재사용(위치, storeId 기준)
    const newMarkers = [];
    await fetchLikes();

    items.forEach((item, index) => {
        const storeId = getStoreId(item);
        const likeCount = storeLikes[storeId] || 0;
        const markerContent = `
            <div class="custom-marker" id="marker-${storeId}">
                <img src="./image.png" class="marker-img" alt="butter tteok">
                ${likeCount > 0 ? `<div class="like-badge">${likeCount}</div>` : ''}
            </div>
        `;
        // 기존 마커 재사용
        let marker = markers.find((m) => {
            const pos = m.getPosition();
            return pos && pos.lat() === item.lat && pos.lng() === item.lng && m.storeId === storeId;
        });
        if (!marker) {
            marker = new naver.maps.Marker({
                position: new naver.maps.LatLng(item.lat, item.lng),
                map: map,
                icon: {
                    content: markerContent,
                    size: new naver.maps.Size(31, 31), // 70% 크기
                    anchor: new naver.maps.Point(15.5, 15.5),
                },
            });
            marker.storeId = storeId;
        } else {
            marker.setIcon({
                content: markerContent,
                size: new naver.maps.Size(31, 31),
                anchor: new naver.maps.Point(15.5, 15.5),
            });
            marker.setMap(map);
        }
        naver.maps.Event.clearInstanceListeners(marker);
        naver.maps.Event.addListener(marker, 'click', (e) => {
            const target = e.domEvent.target;
            if (target.tagName === 'IMG') {
                let badgeEl = document.querySelector(`#marker-${storeId} .like-badge`);
                if (!badgeEl) {
                    const container = document.getElementById(`marker-${storeId}`);
                    if (container) {
                        badgeEl = document.createElement('div');
                        badgeEl.className = 'like-badge';
                        badgeEl.innerText = '0';
                        container.appendChild(badgeEl);
                    }
                }
                handleLike(storeId, badgeEl);
            } else {
                showInfoWindow(marker, item);
            }
        });
        newMarkers.push(marker);
    });
    // 기존 마커 중에 남아있는 것들은 지도에서 제거
    markers.forEach((m) => {
        if (!newMarkers.includes(m)) m.setMap(null);
    });
    markers = newMarkers;
}

function showInfoWindow(marker, item) {
    const content = `
        <div style="padding:15px; min-width:200px; font-family: 'Noto Sans KR', sans-serif;">
            <h4 style="margin:0 0 5px 0; color:#333;">${item.title.replace(/<[^>]*>?/gm, '')}</h4>
            <p style="margin:0; font-size:12px; color:#666;">${item.roadAddress || item.address}</p>
            <a href="https://search.naver.com/search.naver?query=${encodeURIComponent(
                item.title.replace(/<[^>]*>?/gm, ''),
            )}" 
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

// 카카오톡 공유 버튼 생성
function showAddStoreModal() {
    const modal = document.createElement('div');
    modal.style.cssText = `
        position: fixed; top: 0; left: 0; width: 100%; height: 100%;
        background: rgba(0,0,0,0.5); z-index: 2000; display: flex;
        align-items: center; justify-content: center;
    `;
    modal.innerHTML = `
        <div style="background: white; padding: 20px; border-radius: 10px; max-width: 400px; width: 90%;">
            <h3>새 가게 등록(내가 찾은 버터떡 파는집)</h3>
            <input type="text" id="store-name" placeholder="가게 이름" style="width: 100%; padding: 10px; margin: 10px 0; border: 1px solid #ccc; border-radius: 5px;">
            <div style="display: flex; gap: 10px; margin-bottom: 10px;">
                <button id="search-store-btn" style="flex: 1 1 0; background: #FFD93D; color: black; border: none; padding: 10px 0; border-radius: 5px; cursor: pointer; font-weight: 600;">검색</button>
                <button id="close-modal-btn" style="flex: 1 1 0; background: #ccc; color: black; border: none; padding: 10px 0; border-radius: 5px; cursor: pointer; font-weight: 600;">닫기</button>
            </div>
            <div id="search-results" style="margin-top: 10px;"></div>
        </div>
    `;
    document.body.appendChild(modal);

    document.getElementById('close-modal-btn').onclick = () => {
        if (document.body.contains(modal)) {
            document.body.removeChild(modal);
        }
    };

    document.getElementById('search-store-btn').onclick = async () => {
        const nameInput = document.getElementById('store-name');
        const name = nameInput ? nameInput.value : '';
        const resultsDiv = document.getElementById('search-results');
        resultsDiv.innerHTML = '';
        console.log('[DEBUG] 검색어 입력값:', name);
        if (!name) {
            alert('가게 이름을 입력하세요.');
            return;
        }

        try {
            // Naver API로 후보 검색 (백엔드 /api/search 활용)
            const response = await fetch(`/api/search?query=${encodeURIComponent(name)}`);
            const data = await response.json();
            console.log('[DEBUG] /api/search 응답:', data);
            if (!data.items || data.items.length === 0) {
                resultsDiv.innerHTML = '<p style="color:#888;">검색 결과가 없습니다.</p>';
                return;
            }
            // 5km 이내만 필터링 및 거리 계산/정렬
            const RADIUS_KM = 5;
            const items = data.items
                .map((item) => {
                    const dist = getDistanceKm(currentLat, currentLng, item.lat, item.lng);
                    return { ...item, distanceKm: dist };
                })
                .filter((item) => item.distanceKm <= RADIUS_KM)
                .sort((a, b) => a.distanceKm - b.distanceKm);

            if (items.length === 0) {
                resultsDiv.innerHTML = '<p style="color:#888;">반경 5km 내 검색 결과가 없습니다.</p>';
                return;
            }

            // 스크롤바 적용 (최대 높이 300px)
            resultsDiv.style.maxHeight = '300px';
            resultsDiv.style.overflowY = 'auto';

            // 목록 렌더링
            resultsDiv.innerHTML = items
                .map(
                    (item, idx) => `
                <div style="display:flex; align-items:center; justify-content:space-between; padding:8px 0; border-bottom:1px solid #eee; gap:10px;">
                    <div style="flex:1; min-width:0;">
                        <div style="font-weight:600; color:#222; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${item.title.replace(/<[^>]*>?/gm, '')}</div>
                        <div style="font-size:12px; color:#666; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${item.roadAddress || item.address}</div>
                        <div style="font-size:11px; color:#888;">📍 ${item.distanceKm < 1 ? (item.distanceKm * 1000).toFixed(0) + 'm' : item.distanceKm.toFixed(2) + 'km'}</div>
                    </div>
                    <button data-idx="${idx}" style="background:#FFD93D; color:black; border:none; border-radius:5px; padding:7px 14px; font-weight:600; cursor:pointer; flex-shrink:0;">등록</button>
                </div>
            `,
                )
                .join('');

            // 등록 버튼 이벤트
            Array.from(resultsDiv.querySelectorAll('button[data-idx]')).forEach((btn) => {
                btn.onclick = async (e) => {
                    const idx = parseInt(btn.getAttribute('data-idx'), 10);
                    const selected = items[idx];
                    // 실제 DB 등록
                    try {
                        const regRes = await fetch('/api/add-store', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ name: selected.title.replace(/<[^>]*>?/gm, '') }),
                        });
                        const regResult = await regRes.json();
                        if (regResult.success) {
                            alert('가게가 등록되었습니다!');
                            if (document.body.contains(modal)) document.body.removeChild(modal);
                            searchPlaces('버터떡', currentLat, currentLng);
                        } else {
                            alert('등록 실패: ' + regResult.error);
                        }
                    } catch (err) {
                        alert('오류 발생: ' + err.message);
                    }
                };
            });
        } catch (error) {
            resultsDiv.innerHTML = '<p style="color:#e00;">검색 중 오류가 발생했습니다.</p>';
        }
    };
}

// Debugging: Log the query and API response
const searchInput = document.getElementById('search-input');
if (searchInput) {
    searchInput.addEventListener('change', () => {
        const query = searchInput.value.trim();
        console.log('[DEBUG] 검색어 입력값:', query); // Log user input
        if (query) {
            searchPlaces(query, currentLat, currentLng);
        }
    });
}
