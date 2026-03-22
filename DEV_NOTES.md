# butterDduck 지도 프로젝트 정리

## 기술 스택

- 프런트엔드: Kakao Maps JS SDK, Kakao Link SDK, 순수 JS/HTML/CSS
- 백엔드: Express 서버 + Netlify Functions (동일 로직 이중화)
- 데이터: Supabase (likes, stores), 로컬 JSON 없음
- 기타: Axios(FE/BE), Geolocation API, Naver Geocode (address→coord), AdFit 배너

## 앱 구조

```
public/
  index.html      # 랜딩/메인 UI, Kakao 지도 컨테이너, AdFit 영역
  app.js          # 지도 초기화, 검색/마커/좋아요/공유 로직
  styles.css      # 글래스모피즘 테마, 버튼/목록/카드 스타일
server.js         # Express API (개발/로컬)
netlify/functions/server.js # Netlify serverless API (배포)
likes.json        # 사용하지 않음 (과거 잔여)
netlify.toml      # 함수 경로 설정
```

## 주요 흐름 (프런트)

- `initApp()` → Kakao JS/Link 키 로드 → 지도 생성 → 현재 위치/기본 좌표로 `searchPlaces()` 실행
- `searchPlaces()`
    - 지도 bounds/center 기반 `/api/search`(카카오 장소) + `/api/stores-in-bounds`(Supabase) 병렬 호출
    - 결과를 `getStoreKey()`로 중복 제거 후 `fetchLikes()`로 카운트 합치고 좋아요 내림차순+거리 오름차순 정렬
    - `displayPlaces()` 목록 렌더 + `updateMarkers()` 커스텀 오버레이 마커 렌더
- 마커/목록 클릭 → `showInfoWindow()` 커스텀 오버레이 카드 (글래스모피즘) 표시, 외부 클릭 시 닫힘
- 좋아요: `handleLike()` → `/api/likes` POST → Supabase upsert + localStorage 중복 방지
- 공유: Kakao Link feed 메시지, 현재 영역명/결과 수/총 좋아요 포함
- 가게 등록: `/api/search-for-register`로 검색 후 `/api/add-store` 저장

## API (서버 & 함수 공통)

- `GET /api/search?query&lat&lng&swLat&swLng&neLat&neLng`
    - Kakao keyword 1~3페이지, rect(0.5° 이하) 또는 좌표+radius로 검색, bounds로 2차 필터
    - Supabase stores 병합 (주소 중복 방지), distanceKm 정렬
- `GET /api/stores-in-bounds?lat&lng&swLat&swLng&neLat&neLng`
    - Supabase stores 중 bounds 내 데이터 반환 (+distanceKm 계산)
- `GET /api/likes` / `POST /api/likes` (storeKey 기반 카운트)
- `POST /api/add-store` (name, address, lat, lng)
- `GET /api/search-for-register?query` (이미 등록된 주소 제외한 Kakao 검색)
- `GET /api/config` (Kakao JS Key)
- 기타: `GET /api/place-image`, `GET /api/static-thumb` (현재 UI 미사용)

## 데이터 모델 (Supabase)

- `likes`: store_key, count
- `stores`: id, name, address, lat, lng, likes(optional), phone(optional)

## 지도/마커 UI

- 커스텀 오버레이 마커: PNG + 좋아요 칩
- 정보 카드: 제목/주소/전화/카카오 링크, 외부 클릭 시 닫힘
- 목록: 카테고리/이름/주소/좋아요/거리(있을 때) 한 줄 메타, 좋아요 내림차순 표시
- 버튼: 글래스모피즘, “내 위치로” Kakao 맵 크로스헤어 스타일, AdFit 위 오프셋 (`--ad-offset`)

## 스타일 테마

- 글래스모피즘: 투명+블러 배경, 유리 테두리/섀도, 파스텔 그라디언트 배경
- CSS 변수: 색상/유리/섀도/라디우스/AdFit 오프셋

## 배포/개발 팁

- 개발: `node server.js` (루트), env에 `KAKAO_JS_KEY`, `KAKAO_REST_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`
- 배포: Netlify Functions (`netlify/functions/server.js`), 동일 env 필요
- CORS: Express에서 `cors()` 사용
- 키 캐싱: Kakao JS/Link는 init 체크 후 재사용

## 남은 주의사항

- `.vscode/`는 git에 미추적 상태
- 이미지 프록시(place-image/static-thumb)는 현재 UI 미사용, 필요 시 호출

---

본 문서는 유사 프로젝트 참고용으로 기술 스택·흐름·API·스타일 요약을 제공합니다.
