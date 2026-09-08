// Stream each screen into the downloader before scrolling again.
export async function* crawlLinks({ initial = [], read, scroll, maxIdle = 10 }) {
  const seen = new Set();
  const normalize = value => {
    const match = String(value).match(/^https:\/\/www\.tiktok\.com\/@[^/]+\/video\/(\d+)(?:[/?#]|$)/);
    return match ? { id: match[1], url: match[0].replace(/[/?#]$/, '') } : null;
  };
  for (const value of initial) {
    const item = normalize(value);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    yield item.url;
  }
  let idle = 0;
  let found = false;
  while (idle < maxIdle) {
    let added = 0;
    for (const value of await read()) {
      const item = normalize(value);
      if (!item) continue;
      found = true;
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      added++;
      yield item.url;
    }
    idle = added ? 0 : idle + 1;
    if (idle < maxIdle) await scroll();
  }
  if (!found) throw new Error('Khong tim thay video tren trang hashtag; kiem tra truy cap/giao dien TikTok.');
  console.log(`Dung cuon sau ${maxIdle} lan khong co link moi; khong dong nghia da lay het tong posts.`);
}
