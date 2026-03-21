let map;
let markers = [];
let infoWindow;
let currentLat = 37.5665;
let currentLng = 126.978;
let storeLikes = {};
let isSearching = false;
let lastResultCount = 0;
let currentRegionName = '내 주변';
let lastRegionLookupKey = '';

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
        addStoreBtn.onclick = (e) => {
            e.stopPropagation();
            showAddStoreModal();
        };
    }

    const shareBtn = document.getElementById('kakao-share-btn');
    if (shareBtn) {
        shareBtn.onclick = async (e) => {
            e.stopPropagation();
            await shareKakao();
        };
    }

    const headerEl = document.querySelector('header');
    if (headerEl) {
        const recenter = (e) => {
            if (!map) return;
            if (
                e &&
                e.target &&
                e.target.closest &&
                (e.target.closest('#add-store-btn') || e.target.closest('#kakao-share-btn'))
            )
                return;
            map.panTo(new kakao.maps.LatLng(currentLat, currentLng));
        };
        headerEl.addEventListener('click', recenter);
    }
}

// ============================================================
// 첫 방문 온보딩 모달
// ============================================================
function showOnboardingModal() {
    const SEEN_KEY = 'butter_onboarding_seen';
    if (localStorage.getItem(SEEN_KEY) === 'true') return;

    const modal = document.createElement('div');
    modal.style.cssText = `
        position: fixed; inset: 0; background: rgba(0,0,0,0.45);
        display: flex; align-items: center; justify-content: center;
        z-index: 3000; padding: 16px;
    `;

    modal.innerHTML = `
        <div style="background:#fff8e6; border:1px solid #ffe08a; border-radius:16px; max-width:440px; width:100%; box-shadow:0 10px 30px rgba(0,0,0,0.12); font-family:'Noto Sans KR', sans-serif;">
            <div style="padding:18px 20px 12px 20px; display:flex; align-items:center; gap:10px;">
                <div style="font-size:24px;">🧭</div>
                <div>
                    <div style="font-weight:700; color:#2b2b2b; font-size:18px;">버터떡 지도 시작 가이드</div>
                    <div style="color:#555; font-size:13px; margin-top:2px;">내 주변 버터떡집을 10초 안에 찾는 법</div>
                </div>
            </div>
            <div style="padding:0 20px 8px 20px;">
                <ul style="margin:0; padding:0 0 4px 0; list-style:none; display:flex; flex-direction:column; gap:10px;">
                    <li style="display:flex; gap:10px; align-items:flex-start;">
                        <span style="font-size:18px;">🗺️</span>
                        <div style="font-size:14px; color:#333; line-height:1.4;">지도를 움직이면 해당 영역의 버터떡집이 자동으로 갱신됩니다.</div>
                    </li>
                    <li style="display:flex; gap:10px; align-items:flex-start;">
                        <span style="font-size:18px;">👍</span>
                        <div style="font-size:14px; color:#333; line-height:1.4;">마커를 눌러 좋아요를 남기고, 인기 순으로 정렬된 스팟을 확인해 보세요.</div>
                    </li>
                    <li style="display:flex; gap:10px; align-items:flex-start;">
                        <span style="font-size:18px;">📤</span>
                        <div style="font-size:14px; color:#333; line-height:1.4;">상단 공유 버튼으로 친구에게 카톡 공유해 함께 맛집을 찾아보세요.</div>
                    </li>
                </ul>
            </div>
            <div style="padding:12px 20px 18px 20px; display:flex; gap:10px;">
                <button id="onboarding-close" style="flex:1; background:#ffd93d; color:#1f1a00; border:none; border-radius:10px; padding:12px 0; font-weight:700; cursor:pointer; box-shadow:0 4px 10px rgba(0,0,0,0.08);">시작하기</button>
                <button id="onboarding-hide" style="flex:1; background:#f1f3f5; color:#2b2b2b; border:1px solid #e0e0e0; border-radius:10px; padding:12px 0; font-weight:700; cursor:pointer;">다시 보지 않기</button>
            </div>
        </div>
    `;

    const closeModal = (persist) => {
        if (persist) localStorage.setItem(SEEN_KEY, 'true');
        if (document.body.contains(modal)) document.body.removeChild(modal);
    };

    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal(false);
    });

    modal.querySelector('#onboarding-close').onclick = () => closeModal(true);
    modal.querySelector('#onboarding-hide').onclick = () => closeModal(true);

    document.body.appendChild(modal);
}

// ============================================================
// 앱 초기화
// ============================================================
async function initApp() {
    setupMobileUI();
    showOnboardingModal();
    try {
        const configResponse = await fetch('/api/config');
        const config = await configResponse.json();
        if (!config.kakaoJsKey) {
            alert('Kakao Maps JavaScript 키가 설정되지 않았습니다.');
            return;
        }
        await loadKakaoLinkScript(config.kakaoJsKey);
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
        script.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${appKey}&autoload=false&libraries=services`;
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
    });
}

function loadKakaoLinkScript(appKey) {
    return new Promise((resolve, reject) => {
        if (window.Kakao && window.Kakao.init) {
            try {
                if (!window.Kakao.isInitialized()) window.Kakao.init(appKey);
                resolve();
            } catch (err) {
                reject(err);
            }
            return;
        }
        const script = document.createElement('script');
        script.src = 'https://developers.kakao.com/sdk/js/kakao.js';
        script.onload = () => {
            try {
                if (window.Kakao && !window.Kakao.isInitialized()) {
                    window.Kakao.init(appKey);
                }
                resolve();
            } catch (err) {
                reject(err);
            }
        };
        script.onerror = reject;
        document.head.appendChild(script);
    });
}

async function updateRegionName(lat, lng) {
    if (!window.kakao || !window.kakao.maps || !window.kakao.maps.services) return;
    const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
    if (lastRegionLookupKey === key) return;
    lastRegionLookupKey = key;

    const geocoder = new kakao.maps.services.Geocoder();
    return new Promise((resolve) => {
        geocoder.coord2RegionCode(lng, lat, (result, status) => {
            if (status === kakao.maps.services.Status.OK && result && result.length) {
                const target = result.find((r) => r.region_type === 'H' || r.region_type === 'B') || result[0];
                const name = target.region_2depth_name || target.region_1depth_name || target.address_name;
                if (name) currentRegionName = name;
            }
            resolve();
        });
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

        await updateRegionName(center.getLat(), center.getLng());

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
    lastResultCount = items.length;
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
        if (badgeEl) {
            badgeEl.innerText = count;
            badgeEl.classList.add('bump');
            setTimeout(() => badgeEl.classList.remove('bump'), 400);
        }

        likedStores[storeKey] = true;
        localStorage.setItem('liked_stores', JSON.stringify(likedStores));
    } catch (e) {
        console.error('Like failed', e);
    }
}

async function shareKakao() {
    try {
        if (!window.Kakao || !window.Kakao.isInitialized()) {
            alert('카카오톡 공유 준비 중입니다. 잠시 후 다시 시도해주세요.');
            return;
        }

        const center = map?.getCenter();
        if (center) await updateRegionName(center.getLat(), center.getLng());

        const region = currentRegionName || '내 주변';
        const countText = lastResultCount > 0 ? `${lastResultCount}곳` : '여러 곳';
        const likeTotal = storeLikes ? Object.values(storeLikes).reduce((a, b) => a + (b || 0), 0) : 0;

        const title = `🧈 ${region} 버터떡 스팟 ${countText}`;
        const description = `겉바속촉 버터떡 지도에서 인기 스팟을 확인하세요! (좋아요 ${likeTotal}개)`;
        const shareImageUrl = 'https://butterdduck.netlify.app/image.png';
        const shareUrl = 'https://butterdduck.netlify.app';

        window.Kakao.Link.sendDefault({
            objectType: 'feed',
            content: {
                title,
                description,
                imageUrl: shareImageUrl,
                link: {
                    mobileWebUrl: shareUrl,
                    webUrl: shareUrl,
                },
            },
            social: {
                likeCount: likeTotal,
            },
            buttons: [
                {
                    title: '지도로 보기',
                    link: {
                        mobileWebUrl: shareUrl,
                        webUrl: shareUrl,
                    },
                },
                {
                    title: '버터떡 둘러보기',
                    link: {
                        mobileWebUrl: shareUrl,
                        webUrl: shareUrl,
                    },
                },
            ],
        });
    } catch (err) {
        console.error('Kakao share failed', err);
        alert('카카오톡 공유에 실패했습니다.');
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
                <button class="like-chip" aria-label="좋아요" type="button">
                    <span>❤️</span><span class="like-count">${likeCount}</span>
                </button>
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
        const likeBtn = content.querySelector('.like-chip');

        markerEl.onclick = (e) => {
            if (e.target && e.target.closest && e.target.closest('.like-chip')) return;
            showInfoWindow(overlay, item);
        };

        if (likeBtn) {
            likeBtn.onclick = (e) => {
                e.stopPropagation();
                const countEl = likeBtn.querySelector('.like-count');
                handleLike(storeKey, countEl, item);
            };
        }

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
    const address = item.roadAddress || item.address || '주소 정보 없음';
    const phone = item.phone || '연락처 정보 없음';
    const kakaoLink = item.link || `https://map.kakao.com/link/search/${encodeURIComponent(cleanTitle)}`;
    const fallbackImg = 'https://butterdduck.netlify.app/image.png';

    const wrapper = document.createElement('div');
    wrapper.style.padding = '14px';
    wrapper.style.minWidth = '220px';
    wrapper.style.maxWidth = '320px';
    wrapper.style.fontFamily = "'Noto Sans KR', sans-serif";

    const staticImg = item.lat && item.lng ? `/api/static-thumb?lat=${item.lat}&lng=${item.lng}` : fallbackImg;

    wrapper.innerHTML = `
        <div style="display:flex; gap:10px; align-items:flex-start;">
            <div style="width:72px; height:72px; border-radius:12px; overflow:hidden; background:#f6f6f6; flex-shrink:0;">
                <img id="info-img" src="${staticImg}" alt="${cleanTitle}" style="width:100%; height:100%; object-fit:cover; display:block;">
            </div>
            <div style="flex:1; min-width:0;">
                <h4 style="margin:0 0 6px 0; color:#2b2b2b; font-size:15px;">${cleanTitle}</h4>
                <p style="margin:0 0 4px 0; font-size:12px; color:#555; line-height:1.4;">${address}</p>
                <p style="margin:0 0 8px 0; font-size:12px; color:#777;">${phone}</p>
                <a href="${kakaoLink}" target="_blank" style="display:inline-block; margin-top:6px; font-size:12px; color:#ccac00; font-weight:700; text-decoration:none;">카카오 상세보기 →</a>
            </div>
        </div>
    `;

    // 이미지 로드 실패 시 카카오 place 이미지 → 기본 이미지 순으로 대체
    const imgEl = wrapper.querySelector('#info-img');
    let triedPlaceImg = false;
    imgEl.onerror = () => {
        if (!triedPlaceImg && item.link) {
            triedPlaceImg = true;
            fetch(`/api/place-image?url=${encodeURIComponent(item.link)}`)
                .then((res) => res.json())
                .then((data) => {
                    if (data && data.imageUrl) {
                        let src = data.imageUrl;
                        if (src.startsWith('//')) src = 'https:' + src;
                        imgEl.src = src;
                        return;
                    }
                    imgEl.src = fallbackImg;
                })
                .catch(() => {
                    imgEl.src = fallbackImg;
                });
        } else {
            imgEl.src = fallbackImg;
        }
    };

    infoWindow.setContent(wrapper);
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
