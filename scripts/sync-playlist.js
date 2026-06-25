/**
 * YouTube Music Weekly Auto-Playlist Sync Script
 * This script runs autonomously inside GitHub Actions.
 * It fetches all Art Tracks of "김씨티 - TOPIC" daily,
 * records and logs the daily view count and daily increase in a CSV file,
 * and updates the YouTube Music playlist on Fridays with the Top 10 most popular tracks
 * (ranked by the view count increase over the last 7 days).
 */

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

// Target CSV file path in the repository root
const csvFilePath = path.join(__dirname, '../art_track_views.csv');

// Helper to parse duration or any date values
function getKSTDateString(dateObj = new Date()) {
  const kstOffset = 9 * 60 * 60 * 1000; // KST is UTC+9
  const kstDate = new Date(dateObj.getTime() + kstOffset);
  return kstDate.toISOString().split('T')[0];
}

async function findTopicChannelId(youtube) {
  // Try custom channel ID from env first
  if (process.env.TOPIC_CHANNEL_ID) {
    console.log(`Using configured TOPIC_CHANNEL_ID from env: ${process.env.TOPIC_CHANNEL_ID}`);
    return process.env.TOPIC_CHANNEL_ID;
  }

  console.log('Searching for "김씨티 - TOPIC" channel ID...');
  try {
    const searchRes = await youtube.search.list({
      part: ['snippet'],
      q: '김씨티 - TOPIC',
      type: 'channel',
      maxResults: 5
    });

    if (searchRes.data.items && searchRes.data.items.length > 0) {
      for (const item of searchRes.data.items) {
        const title = item.snippet?.title || '';
        const channelId = item.id?.channelId || item.snippet?.channelId;
        if (title.includes('김씨티') && (title.toLowerCase().includes('topic') || title.includes('테마'))) {
          console.log(`Found Topic Channel via Channel Search: ${title} (${channelId})`);
          return channelId;
        }
      }
    }
  } catch (err) {
    console.error('Error searching for topic channel:', err.message);
  }

  // Fallback: search for videos to extract the Topic channel ID
  try {
    const searchVideoRes = await youtube.search.list({
      part: ['snippet'],
      q: '김씨티 - TOPIC',
      type: 'video',
      maxResults: 10
    });
    if (searchVideoRes.data.items) {
      for (const item of searchVideoRes.data.items) {
        const channelId = item.snippet?.channelId;
        const channelTitle = item.snippet?.channelTitle || '';
        if (channelId && channelTitle.includes('김씨티') && (channelTitle.toLowerCase().includes('topic') || channelTitle.includes('테마'))) {
          console.log(`Found Topic Channel ID via Video Search: ${channelTitle} (${channelId})`);
          return channelId;
        }
      }
    }
  } catch (err) {
    console.error('Error searching for Topic videos:', err.message);
  }

  console.warn('Could not find specific "김씨티 - Topic" channel ID automatically. Defaulting to mine.');
  return null;
}

// Custom simple CSV Parser
function loadCsvRecords() {
  const records = [];
  if (!fs.existsSync(csvFilePath)) {
    return records;
  }

  try {
    const content = fs.readFileSync(csvFilePath, 'utf8');
    const lines = content.split('\n');
    
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const row = [];
      let current = '';
      let inQuotes = false;
      for (let charIdx = 0; charIdx < line.length; charIdx++) {
        const char = line[charIdx];
        if (char === '"') {
          inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
          row.push(current.trim());
          current = '';
        } else {
          current += char;
        }
      }
      row.push(current.trim());

      if (row.length >= 4) {
        const date = row[0];
        const videoId = row[1];
        const title = row[2].replace(/^"|"$/g, ''); // Unquote
        const views = parseInt(row[3], 10) || 0;
        const increase = parseInt(row[4], 10) || 0;
        records.push({ date, videoId, title, views, increase });
      }
    }
  } catch (err) {
    console.error('Error parsing CSV records:', err.message);
  }
  return records;
}

// Get the latest recorded entry for a video
function getLatestRecordForVideo(records, videoId) {
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i].videoId === videoId) {
      return records[i];
    }
  }
  return null;
}

async function syncPlaylist() {
  console.log('=== [Sync Start] Daily View Tracker & Weekly Auto-Sync ===');

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  const playlistId = process.env.YOUTUBE_PLAYLIST_ID;

  if (!clientId || !clientSecret || !refreshToken || !playlistId) {
    console.error('Error: Required environment variables are missing (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, YOUTUBE_PLAYLIST_ID).');
    process.exit(1);
  }

  // 1. Authenticate with Google API
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

  // 2. Resolve Topic Channel ID
  const topicChannelId = await findTopicChannelId(youtube);
  if (!topicChannelId) {
    console.error('CRITICAL ERROR: Unable to proceed without a valid Channel ID.');
    process.exit(1);
  }

  // 3. Obtain Uploads Playlist ID for the Topic Channel
  let uploadsPlaylistId = null;
  try {
    const channelRes = await youtube.channels.list({
      part: ['contentDetails'],
      id: topicChannelId
    });
    uploadsPlaylistId = channelRes.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  } catch (err) {
    console.error('Error fetching channel uploads playlist:', err.message);
  }

  // Fallback: construct uploads playlist from channel ID
  if (!uploadsPlaylistId && topicChannelId.startsWith('UC')) {
    uploadsPlaylistId = 'UU' + topicChannelId.substring(2);
  }

  if (!uploadsPlaylistId) {
    console.error('CRITICAL ERROR: Uploads playlist ID not found.');
    process.exit(1);
  }

  console.log(`Topic Channel Uploads Playlist ID: ${uploadsPlaylistId}`);

  // 4. Retrieve all Art Tracks from the Uploads Playlist
  console.log('Fetching all uploaded tracks (Art Tracks) from Topic uploads playlist...');
  const artTracks = [];
  try {
    let pageToken = undefined;
    do {
      const res = await youtube.playlistItems.list({
        part: ['snippet'],
        playlistId: uploadsPlaylistId,
        maxResults: 50,
        pageToken: pageToken
      });
      if (res.data.items) {
        for (const item of res.data.items) {
          const videoId = item.snippet?.resourceId?.videoId;
          const title = item.snippet?.title || '';
          if (videoId) {
            artTracks.push({
              id: videoId,
              title: title
            });
          }
        }
      }
      pageToken = res.data.nextPageToken;
    } while (pageToken);
    console.log(`Successfully fetched ${artTracks.length} total Art Tracks.`);
  } catch (err) {
    console.error('Error listing playlist items:', err.message);
  }

  // Fallback to Search if list is completely empty
  if (artTracks.length === 0) {
    console.log('Playlist items list was empty. Attempting direct search fallback...');
    try {
      let pageToken = undefined;
      for (let page = 0; page < 3; page++) {
        const searchRes = await youtube.search.list({
          part: ['snippet'],
          q: '김씨티 - TOPIC',
          type: 'video',
          maxResults: 50,
          pageToken: pageToken
        });
        if (searchRes.data.items) {
          for (const item of searchRes.data.items) {
            const videoId = item.id?.videoId;
            const title = item.snippet?.title || '';
            const channelTitle = item.snippet?.channelTitle || '';
            if (videoId && (channelTitle.includes('김씨티') && (channelTitle.toLowerCase().includes('topic') || channelTitle.includes('테마')))) {
              if (!artTracks.some(v => v.id === videoId)) {
                artTracks.push({ id: videoId, title: title });
              }
            }
          }
        }
        pageToken = searchRes.data.nextPageToken;
        if (!pageToken) break;
      }
      console.log(`Fallback search retrieved ${artTracks.length} Art Tracks.`);
    } catch (err) {
      console.error('Error during fallback search:', err.message);
    }
  }

  if (artTracks.length === 0) {
    console.warn('No Art Tracks were found. Skipping views recording.');
    return;
  }

  // 5. Query exact real-time views from Video API
  console.log('Querying precise real-time views for all tracks...');
  const videoStatsMap = new Map();
  const videoIds = artTracks.map(v => v.id);
  const chunkSize = 50;

  for (let i = 0; i < videoIds.length; i += chunkSize) {
    const chunk = videoIds.slice(i, i + chunkSize);
    try {
      const statsRes = await youtube.videos.list({
        part: ['statistics', 'snippet'],
        id: chunk
      });
      if (statsRes.data.items) {
        for (const item of statsRes.data.items) {
          videoStatsMap.set(item.id, {
            title: item.snippet?.title || '',
            views: parseInt(item.statistics?.viewCount || '0', 10)
          });
        }
      }
    } catch (err) {
      console.error(`Error querying video statistics for chunk starting at ${i}:`, err.message);
    }
  }

  // 6. Record views daily to the CSV file
  const todayRecords = [];
  const existingRecords = loadCsvRecords();
  const dateString = getKSTDateString();

  console.log(`Recording daily snapshot for KST date: ${dateString}...`);

  for (const track of artTracks) {
    const stats = videoStatsMap.get(track.id);
    if (!stats) continue;

    const currentViews = stats.views;
    const lastRecord = getLatestRecordForVideo(existingRecords, track.id);
    
    let increase = 0;
    if (lastRecord) {
      increase = currentViews - lastRecord.views;
      if (increase < 0) {
        increase = 0; // Guard against negative values from YouTube's statistics corrections
      }
    }

    todayRecords.push({
      date: dateString,
      videoId: track.id,
      title: stats.title,
      views: currentViews,
      increase: increase
    });
  }

  // Write new records to CSV file
  const fileExists = fs.existsSync(csvFilePath);
  const header = 'Date,Video ID,Title,Views,Daily Increase\n';
  let appendContent = '';

  if (!fileExists) {
    appendContent += header;
  }

  for (const r of todayRecords) {
    let safeTitle = r.title.replace(/"/g, '""');
    if (safeTitle.includes(',') || safeTitle.includes('"')) {
      safeTitle = `"${safeTitle}"`;
    }
    appendContent += `${r.date},${r.videoId},${safeTitle},${r.views},${r.increase}\n`;
  }

  fs.appendFileSync(csvFilePath, appendContent, 'utf8');
  console.log(`Saved ${todayRecords.length} records for ${dateString} in CSV.`);

  // Update existingRecords array in memory
  existingRecords.push(...todayRecords);

  // 7. Playlist sync: run if today is Friday (KST) or FORCE_PLAYLIST_UPDATE is configured
  const kstDate = new Date(new Date().getTime() + 9 * 60 * 60 * 1000);
  const isFriday = kstDate.getUTCDay() === 5; // Friday is 5
  const isForceUpdate = process.env.FORCE_PLAYLIST_UPDATE === 'true';

  if (isFriday || isForceUpdate) {
    console.log(`=== [Playlist Update Triggered] (isFriday: ${isFriday}, isForceUpdate: ${isForceUpdate}) ===`);
    
    // Calculate weekly popularity: views increase over the last 7 days
    const sevenDaysAgoDate = new Date(kstDate.getTime() - 7 * 24 * 60 * 60 * 1000);
    const sevenDaysAgoStr = sevenDaysAgoDate.toISOString().split('T')[0];

    const popularityList = [];

    for (const track of artTracks) {
      const stats = videoStatsMap.get(track.id);
      if (!stats) continue;

      const currentViews = stats.views;

      // Filter records in the last 7 days (date >= sevenDaysAgo && date < today)
      // and sort by date to find the oldest views record in this period
      const pastRecords = existingRecords.filter(r => r.videoId === track.id && r.date >= sevenDaysAgoStr && r.date < dateString);
      
      let baseViews = currentViews;
      if (pastRecords.length > 0) {
        pastRecords.sort((a, b) => a.date.localeCompare(b.date));
        baseViews = pastRecords[0].views;
        console.log(`Track "${stats.title}" (${track.id}): views on ${pastRecords[0].date} was ${baseViews}`);
      } else {
        // If there's no record from the past week, find any oldest record overall in the CSV
        const allPast = existingRecords.filter(r => r.videoId === track.id && r.date < dateString);
        if (allPast.length > 0) {
          allPast.sort((a, b) => a.date.localeCompare(b.date));
          baseViews = allPast[0].views;
          console.log(`Track "${stats.title}" (${track.id}): falling back to oldest record overall on ${allPast[0].date} with views ${baseViews}`);
        } else {
          console.log(`Track "${stats.title}" (${track.id}): no past records found. Using current views as base (increase = 0).`);
        }
      }

      const weeklyIncrease = currentViews - baseViews;
      popularityList.push({
        id: track.id,
        title: stats.title,
        weeklyIncrease: weeklyIncrease >= 0 ? weeklyIncrease : 0,
        totalViews: currentViews
      });
    }

    // Sort popular list: 1st by weeklyIncrease DESC, 2nd by totalViews DESC
    popularityList.sort((a, b) => {
      if (b.weeklyIncrease !== a.weeklyIncrease) {
        return b.weeklyIncrease - a.weeklyIncrease;
      }
      return b.totalViews - a.totalViews;
    });

    console.log('=== [Current Popularity Rankings (Weekly Increase)] ===');
    popularityList.forEach((item, index) => {
      console.log(`${index + 1}. ${item.title} (ID: ${item.id}) | Weekly Increase: +${item.weeklyIncrease} views (Total: ${item.totalViews})`);
    });

    const top10Tracks = popularityList.slice(0, 10);
    const top10VideoIds = top10Tracks.map(item => item.id);

    console.log(`Selected Top 10 tracks for playlist update:`, top10Tracks.map(t => t.title).join(', '));

    if (top10VideoIds.length > 0) {
      await updatePlaylist(youtube, playlistId, top10VideoIds);

      // Save Top 10 Report to TXT file
      try {
        const reportFileName = `sync_report_${dateString}.txt`;
        const reportFilePath = path.join(__dirname, `../${reportFileName}`);
        let reportContent = `=== [YouTube Music Top 10 Playlist Sync Report - ${dateString}] ===\n`;
        reportContent += `Generated At (KST): ${new Date(kstDate.getTime()).toISOString().replace('T', ' ').substring(0, 19)}\n\n`;

        top10Tracks.forEach((item, index) => {
          reportContent += `${index + 1}. ${item.title}\n`;
          reportContent += `   - 늘어난 조회수 (지난 7일간): +${item.weeklyIncrease.toLocaleString()}회\n`;
          reportContent += `   - 전체 조회수: ${item.totalViews.toLocaleString()}회\n`;
          reportContent += `   - 비디오 ID: ${item.id}\n\n`;
        });

        fs.writeFileSync(reportFilePath, reportContent, 'utf8');
        console.log(`[Success] Top 10 report successfully saved to ${reportFileName}`);
      } catch (err) {
        console.error('Failed to write Top 10 report text file:', err.message);
      }
    } else {
      console.warn('No top tracks found to populate playlist.');
    }
  } else {
    console.log(`Today is not Friday (KST: ${dateString}, Day: ${kstDate.getUTCDay()}). Skipping playlist update.`);
  }

  console.log('=== [Sync Complete] Execution Finished Successfully. ===');
}

async function updatePlaylist(youtube, playlistId, topVideoIds) {
  console.log(`Clearing and updating Playlist ID: ${playlistId}...`);
  
  // 1. Fetch current items in the playlist
  const existingItemIds = [];
  try {
    let pageToken = undefined;
    do {
      const listRes = await youtube.playlistItems.list({
        part: ['id', 'snippet'],
        playlistId: playlistId,
        maxResults: 50,
        pageToken: pageToken
      });
      if (listRes.data.items) {
        for (const item of listRes.data.items) {
          existingItemIds.push({
            itemId: item.id,
            title: item.snippet?.title,
            videoId: item.snippet?.resourceId?.videoId
          });
        }
      }
      pageToken = listRes.data.nextPageToken;
    } while (pageToken);
    console.log(`Currently there are ${existingItemIds.length} items in the playlist.`);
  } catch (error) {
    console.error(`Error listing playlist items:`, error.message);
    return;
  }

  // 2. Clear current playlist items
  if (existingItemIds.length > 0) {
    console.log('Deleting existing playlist items to reset...');
    for (const item of existingItemIds) {
      try {
        await youtube.playlistItems.delete({ id: item.itemId });
        console.log(`Deleted item: ${item.title || item.itemId}`);
      } catch (error) {
        console.error(`Warning: Failed to delete playlist item ${item.itemId}:`, error.message);
      }
    }
    console.log('Playlist clear complete.');
  }

  // 3. Insert top performing videos in rank order
  console.log('Adding new top 10 tracks to the playlist...');
  const syncedVideos = [];
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
      console.log(`[Rank ${i + 1}] Successfully added Video ID: ${videoId}`);
      syncedVideos.push(videoId);
    } catch (error) {
      console.error(`Error adding Video ID ${videoId} at rank ${i + 1}:`, error.message);
    }
  }
  console.log(`Successfully synced ${syncedVideos.length} videos to the playlist.`);
}

syncPlaylist().catch(err => {
  console.error('Unhandled script failure:', err);
  process.exit(1);
});
