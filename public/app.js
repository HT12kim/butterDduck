let map;
let markers = [];
let infoWindow;
let currentLat = 37.5665;
let currentLng = 126.978;
let storeLikes = {};
let isSearching = false;

// ============================================================
// 모바일 UI 초기화
// ============================================================
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
            if (map) map.panTo(new kakao.maps.LatLng(currentLat, currentLng));
        };
    }
    const addStoreBtn = document.getElementById('add-store-btn');
    if (addStoreBtn) {
        addStoreBtn.onclick = () => showAddStoreModal();
    }
}

// ============================================================
// 앱 초기화
// ============================================================
async function initApp() {
    setupMobileUI();
    try {
        const configResponse = await fetch('/api/config');
        const config = await configResponse.json();
        if (!config.kakaoJsKey) {
            alert('Kakao Maps JavaScript 키가 설정되지 않았습니다.');
            return;
        }
        await loadKakaoMapsScript(config.kakaoJsKey);

        let isInitialized = false;
        const initTimeout = setTimeout(() => {
            if (!isInitialized) {
                isInitialized = true;
                kakao.maps.load(() => initializeMap(currentLat, currentLng));
            }
        }, 8000);

        if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition(
                (pos) => {
                    if (isInitialized) return;
                    isInitialized = true;
                    clearTimeout(initTimeout);
                    currentLat = pos.coords.latitude;
                    currentLng = pos.coords.longitude;
                    kakao.maps.load(() => initializeMap(currentLat, currentLng));
                },
                () => {
                    if (isInitialized) return;
                    isInitialized = true;
                    clearTimeout(initTimeout);
                    kakao.maps.load(() => initializeMap(currentLat, currentLng));
                },
                { timeout: 5000, enableHighAccuracy: true },
            );
        } else {
            isInitialized = true;
            clearTimeout(initTimeout);
            kakao.maps.load(() => initializeMap(currentLat, currentLng));
        }
    } catch (error) {
        console.error('Initialization error:', error);
        const overlay = document.getElementById('loading-overlay');
        if (overlay) overlay.style.display = 'none';
    }
}

function loadKakaoMapsScript(appKey) {
    return new Promise((resolve, reject) => {
        if (window.kakao && window.kakao.maps) {
            resolve();
            return;
        }
        const script = document.createElement('script');
        script.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${appKey}&autoload=false`;
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
    });
}

// ============================================================
// 지도 초기화
// ============================================================
function initializeMap(lat, lng) {
    const container = document.getElementById('map');
    map = new kakao.maps.Map(container, {
        center: new kakao.maps.LatLng(lat, lng),
        level: 4,
    });

    infoWindow = new kakao.maps.InfoWindow({ zIndex: 3 });

    const myLocationContent = document.createElement('div');
    myLocationContent.innerHTML = `
        <div class="my-location-marker">
            <div class="pulse"></div>
            <div class="dot"></div>
        </div>
        <div style="
            margin-top: 4px; background: #4A90D9; color: white;
            font-size: 11px; font-weight: bold; font-family: 'Noto Sans KR', sans-serif;
            padding: 2px 8px; border-radius: 10px; white-space: nowrap;
            box-shadow: 0 1px 4px rgba(0,0,0,0.2);
        ">📍 내 위치</div>
    `;
    new kakao.maps.CustomOverlay({
        position: new kakao.maps.LatLng(currentLat, currentLng),
        content: myLocationContent,
        yAnchor: 1,
        zIndex: 1000,
        map,
    });

    const overlay = document.getElementById('loading-overlay');
    if (overlay) {
        overlay.style.opacity = '0';
        setTimeout(() => {
            overlay.style.display = 'none';
        }, 300);
    }

    searchPlaces();

    let idleTimer = null;
    kakao.maps.event.addListener(map, 'idle', () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => searchPlaces(), 300);
    });
}

// ============================================================
// 지도 화면 기반 검색
// ============================================================
async function searchPlaces() {
    if (!map || isSearching) return;
    isSearching = true;

    try {
        const bounds = map.getBounds();
        const center = map.getCenter();
        const sw = bounds.getSouthWest();
        const ne = bounds.getNorthEast();

        const params = new URLSearchParams({
            query: '버터떡',
            lat: center.getLat(),
            lng: center.getLng(),
            swLat: sw.getLat(),
            swLng: sw.getLng(),
            neLat: ne.getLat(),
            neLng: ne.getLng(),
        });

        const response = await fetch(`/api/search?${params}`);
        const data = await response.json();

        if (data.items) {
            await fetchLikes(); // 좋아요 캐시를 먼저 가져온다.
            displayPlaces(data.items);
            await updateMarkers(data.items);
        }
    } catch (error) {
        console.error('Search error:', error);
    } finally {
        isSearching = false;
    }
}

// ============================================================
// 거리 계산 (Haversine)
// ============================================================
function getDistanceKm(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLng = ((lng2 - lng1) * Math.PI) / 180;
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ============================================================
// 목록 표시
// ============================================================
function displayPlaces(items) {
    const listContainer = document.getElementById('places-list');
    const resultCount = document.getElementById('result-count');
    resultCount.textContent = items.length;

    if (items.length === 0) {
        listContainer.innerHTML = '<p class="empty-msg">이 지역에 검색결과가 없습니다. 지도를 이동해보세요.</p>';
        return;
    }

    listContainer.innerHTML = '';
    items.forEach((item, index) => {
        const dist =
            item.distanceKm != null
                ? item.distanceKm < 1
                    ? (item.distanceKm * 1000).toFixed(0) + 'm'
                    : item.distanceKm.toFixed(2) + 'km'
                : '';
        const div = document.createElement('div');
        div.className = 'place-item';
        div.innerHTML = `
            <span class="category">${item.category || ''}</span>
            <h3>${(item.title || '').replace(/<[^>]*>?/gm, '')}</h3>
            <p class="address">${item.roadAddress || item.address || ''}</p>
            ${dist ? `<p class="distance">📍 ${dist}</p>` : ''}
        `;
        div.onclick = () => {
            if (!map) return;
            map.panTo(new kakao.maps.LatLng(item.lat, item.lng));
            if (markers[index]) showInfoWindow(markers[index], item);
        };
        listContainer.appendChild(div);
    });
}

// ============================================================
// storeKey 생성 (제목+주소 해시)
// ============================================================
function getStoreKey(item) {
    const str = ((item.title || '') + (item.address || '')).replace(/<[^>]*>?/gm, '').replace(/\s+/g, '');
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = (hash << 5) - hash + str.charCodeAt(i);
        hash |= 0;
    }
    return 'store_' + Math.abs(hash);
}

// ============================================================
// 좋아요 불러오기
// ============================================================
async function fetchLikes() {
    try {
        const res = await fetch('/api/likes');
        storeLikes = await res.json();
    } catch (e) {
        console.error('Failed to fetch likes', e);
    }
}

// ============================================================
// 좋아요 처리 (가게별 1회, localStorage 기반 체크 + Supabase 저장)
// ============================================================
async function handleLike(storeKey, badgeEl, item) {
    const likedStores = JSON.parse(localStorage.getItem('liked_stores') || '{}');
    if (likedStores[storeKey]) {
        alert('이미 "좋아요"를 누른 가게입니다! 🥰');
        return;
    }

    try {
        const res = await fetch('/api/likes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                storeKey,
                title: item?.title,
                address: item?.roadAddress || item?.address,
                lat: item?.lat,
                lng: item?.lng,
            }),
        });
        const data = await res.json();
        const count = data.count ?? (Number(badgeEl?.innerText) || 0) + 1;
        storeLikes[storeKey] = count;

        if (!badgeEl) {
            const container = document.getElementById(`marker-${storeKey}`);
            if (container) {
                badgeEl = document.createElement('div');
                badgeEl.className = 'like-badge';
                container.appendChild(badgeEl);
            }
        }
        if (badgeEl) {
            badgeEl.innerText = count;
            badgeEl.style.display = 'flex';
            badgeEl.classList.add('bump');
            setTimeout(() => badgeEl.classList.remove('bump'), 400);
        }

        likedStores[storeKey] = true;
        localStorage.setItem('liked_stores', JSON.stringify(likedStores));
    } catch (e) {
        console.error('Like failed', e);
    }
}

// ============================================================
// 마커 업데이트 (깜빡임 방지: 기존 커스텀 오버레이 재사용)
// ============================================================
async function updateMarkers(items) {
    await fetchLikes();
    const newMarkers = [];

    items.forEach((item) => {
        const storeKey = getStoreKey(item);
        const likeCount = storeLikes[storeKey] ?? 0;

        const content = document.createElement('div');
        content.innerHTML = `
            <div class="custom-marker" id="marker-${storeKey}">
                <img src="./image.png" class="marker-img" alt="marker">
                <div class="like-badge" style="display:flex">${likeCount}</div>
            </div>
        `;

        let overlay = markers.find(
            (m) =>
                m.storeKey === storeKey &&
                m.getPosition().getLat() === item.lat &&
                m.getPosition().getLng() === item.lng,
        );

        if (!overlay) {
            overlay = new kakao.maps.CustomOverlay({
                position: new kakao.maps.LatLng(item.lat, item.lng),
                content,
                yAnchor: 1,
                map,
            });
            overlay.storeKey = storeKey;
        } else {
            overlay.setContent(content);
            overlay.setPosition(new kakao.maps.LatLng(item.lat, item.lng));
            overlay.setMap(map);
        }

        const markerEl = content.querySelector(`#marker-${storeKey}`);
        markerEl.onclick = () => {
            const badgeEl = markerEl.querySelector('.like-badge');
            handleLike(storeKey, badgeEl, item);
        };

        newMarkers.push(overlay);
    });

    markers.forEach((m) => {
        if (!newMarkers.includes(m)) m.setMap(null);
    });
    markers = newMarkers;
}

// ============================================================
// 정보 창
// ============================================================
function showInfoWindow(marker, item) {
    const cleanTitle = (item.title || '').replace(/<[^>]*>?/gm, '');
    const content = `
        <div style="padding:15px; min-width:200px; font-family: 'Noto Sans KR', sans-serif;">
            <h4 style="margin:0 0 5px 0; color:#333;">${cleanTitle}</h4>
            <p style="margin:0; font-size:12px; color:#666;">${item.roadAddress || item.address || ''}</p>
            <a href="https://search.daum.net/search?w=tot&q=${encodeURIComponent(cleanTitle)}"
               target="_blank"
               style="display:inline-block; margin-top:8px; font-size:12px; color:#ccac00; text-decoration:none; font-weight:bold;">
               상세보기 →
            </a>
        </div>
    `;
    infoWindow.setContent(content);
    infoWindow.setPosition(marker.getPosition());
    infoWindow.open(map);
}

// ============================================================
// 가게 등록 모달
// ============================================================
function showAddStoreModal() {
    const modal = document.createElement('div');
    modal.style.cssText = `
        position: fixed; top: 0; left: 0; width: 100%; height: 100%;
        background: rgba(0,0,0,0.5); z-index: 2000; display: flex;
        align-items: center; justify-content: center;
    `;
    modal.innerHTML = `
        <div style="background: white; padding: 20px; border-radius: 10px; max-width: 400px; width: 90%;">
            <h3>새 가게 등록 (내가 찾은 버터떡 파는집)</h3>
            <input type="text" id="store-name" placeholder="가게 이름" style="width: 100%; padding: 10px; margin: 10px 0; border: 1px solid #ccc; border-radius: 5px;">
            <div style="display: flex; gap: 10px; margin-bottom: 10px;">
                <button id="search-store-btn" style="flex:1; background:#FFD93D; color:black; border:none; padding:10px 0; border-radius:5px; cursor:pointer; font-weight:600;">검색</button>
                <button id="close-modal-btn" style="flex:1; background:#ccc; color:black; border:none; padding:10px 0; border-radius:5px; cursor:pointer; font-weight:600;">닫기</button>
            </div>
            <div id="search-results" style="margin-top: 10px;"></div>
        </div>
    `;
    document.body.appendChild(modal);

    document.getElementById('close-modal-btn').onclick = () => {
        if (document.body.contains(modal)) document.body.removeChild(modal);
    };

    document.getElementById('search-store-btn').onclick = async () => {
        const name = (document.getElementById('store-name').value || '').trim();
        const resultsDiv = document.getElementById('search-results');
        resultsDiv.innerHTML = '';
        if (!name) {
            alert('가게 이름을 입력하세요.');
            return;
        }

        try {
            const response = await fetch(`/api/search-for-register?query=${encodeURIComponent(name)}`);
            const data = await response.json();

            if (!data.items || data.items.length === 0) {
                resultsDiv.innerHTML = '<p style="color:#888;">검색 결과가 없거나 이미 모두 등록되어 있습니다.</p>';
                return;
            }

            resultsDiv.style.maxHeight = '300px';
            resultsDiv.style.overflowY = 'auto';

            resultsDiv.innerHTML = data.items
                .map(
                    (item, idx) => `
                <div style="display:flex; align-items:center; justify-content:space-between; padding:8px 0; border-bottom:1px solid #eee; gap:10px;">
                    <div style="flex:1; min-width:0;">
                        <div style="font-weight:600; color:#222; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${item.title}</div>
                        <div style="font-size:12px; color:#666; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${item.address}</div>
                        <div style="font-size:11px; color:#888;">${item.category || ''}</div>
                    </div>
                    <button data-idx="${idx}" style="background:#FFD93D; color:black; border:none; border-radius:5px; padding:7px 14px; font-weight:600; cursor:pointer; flex-shrink:0;">등록</button>
                </div>
            `,
                )
                .join('');

            resultsDiv.querySelectorAll('button[data-idx]').forEach((btn) => {
                btn.onclick = async () => {
                    const idx = parseInt(btn.getAttribute('data-idx'), 10);
                    const selected = data.items[idx];
                    try {
                        const regRes = await fetch('/api/add-store', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                name: selected.title,
                                address: selected.address,
                                lat: selected.lat,
                                lng: selected.lng,
                            }),
                        });
                        const regResult = await regRes.json();
                        if (regResult.success) {
                            alert('가게가 등록되었습니다!');
                            if (document.body.contains(modal)) document.body.removeChild(modal);
                            searchPlaces();
                        } else {
                            alert('등록 실패: ' + (regResult.error || ''));
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

document.addEventListener('DOMContentLoaded', initApp);
