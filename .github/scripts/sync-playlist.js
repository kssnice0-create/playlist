/**
 * scripts/sync-playlist.js
 * 이 스크립트는 깃허브 액션에 의해 매주 자동 작동되어,
 * 이전 7일 동안 누적 조회수가 가장 많은 아티스트의 상위 10개 음원을 추출하여,
 * 타겟 유튜브 뮤직 재생목록을 완전히 교체합니다.
 */

const { google } = require('googleapis');

async function syncPlaylist() {
  console.log('--- [자동 동기화 시작] ---');

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  const playlistId = process.env.YOUTUBE_PLAYLIST_ID;

  if (!clientId || !clientSecret || !refreshToken || !playlistId) {
    console.error('환경 변수 설정 에러(Required environment variables are missing).');
    process.exit(1);
  }

  // 1. Google OAuth2 클라이언트 초기화
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oauth2Client.setCredentials({ refresh_token: refreshToken });

  const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
  const ytAnalytics = google.youtubeAnalytics({ version: 'v2', auth: oauth2Client });

  // 2. 유튜브 애널리틱스를 통한 최근 7일간 최다 조회 동영상 Top 10 추출
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const formatDate = (d) => d.toISOString().split('T')[0];

  const startDate = formatDate(sevenDaysAgo);
  const endDate = formatDate(now);
  console.log(`분석 기간: ${startDate} ~ ${endDate}`);

  let topVideoIds = [];
  try {
    const report = await ytAnalytics.reports.query({
      ids: 'channel==MINE',
      startDate: startDate,
      endDate: endDate,
      metrics: 'views',
      dimensions: 'video',
      sort: '-views',
      maxResults: 10
    });

    const rows = report.data.rows || [];
    if (rows.length === 0) {
      console.warn('최근 7일간 재생 횟수나 통계가 검출되지 않아 작동을 중지합니다.');
      return;
    }

    topVideoIds = rows.map(row => row[0]);
    console.log(`감지된 Top 10 비디오 ID 목록:`, topVideoIds);
  } catch (err) {
    console.error('유튜브 애널리틱스 쿼리 실패란:', err.message);
    process.exit(1);
  }

  // 3. 기존 대상 재생목록 내의 모든 아이템 조회
  console.log('기존 재생목록 비우기를 진행합니다...');
  const existingItemIds = [];
  try {
    let pageToken = undefined;
    do {
      const listRes = await youtube.playlistItems.list({
        part: ['id'],
        playlistId: playlistId,
        maxResults: 50,
        pageToken: pageToken
      });
      if (listRes.data.items) {
        for (const item of listRes.data.items) {
          existingItemIds.push(item.id);
        }
      }
      pageToken = listRes.data.nextPageToken;
    } while (pageToken);
  } catch (err) {
    console.error('재생목록 조회를 실패하였습니다. ID를 확인하세요:', err.message);
    process.exit(1);
  }

  // 4. 기존 아이템 전체 삭제 (Clear)
  for (const itemId of existingItemIds) {
    try {
      await youtube.playlistItems.delete({ id: itemId });
    } catch (err) {
      console.error(`재생목록 리스트 아이템 \${itemId} 삭제 에러:`, err.message);
    }
  }
  console.log('재생목록 초기화 완료.');

  // 5. 새 상위 Top 10 순차 주입 (Insert)
  console.log('최근 주간 Top 10 음원 추가 중...');
  for (let i = 0; i < topVideoIds.length; i++) {
    const videoId = topVideoIds[i];
    try {
      await youtube.playlistItems.insert({
        part: ['snippet'],
        requestBody: {
          snippet: {
            playlistId: playlistId,
            position: i,
            resourceId: {
              kind: 'youtube#video',
              videoId: videoId
            }
          }
        }
      });
      console.log(`[\${i + 1}위] 음원 등록 성공 (ID: \${videoId})`);
    } catch (err) {
      console.error(`음원 등록 실패 (ID: \${videoId}):`, err.message);
    }
  }

  console.log('--- [자동 동기화 완료] 모든 인기 음원을 갱신하였습니다! ---');
}

syncPlaylist();
