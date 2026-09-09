function firstUrl(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value?.urlList)) return value.urlList.find(url => typeof url === 'string') || null;
  return null;
}

const present = entries => Object.fromEntries(entries.filter(([, value]) => value !== undefined && value !== null));

export function channelMetadata({ author = {}, stats = null, username, url, tag, region, language, capturedAt }) {
  const avatar = present([
    ['thumb', firstUrl(author.avatarThumb)],
    ['medium', firstUrl(author.avatarMedium)],
    ['large', firstUrl(author.avatarLarger)],
  ]);
  const settings = present([
    ['comments', author.commentSetting],
    ['duet', author.duetSetting],
    ['stitch', author.stitchSetting],
    ['downloads', author.downloadSetting],
    ['favoritesOpen', author.openFavorite],
  ]);
  return present([
    ['id', author.id],
    ['secUid', author.secUid],
    ['username', username || author.uniqueId],
    ['nickname', author.nickname],
    ['url', url],
    ['bio', author.signature],
    ['verified', author.verified],
    ['privateAccount', author.privateAccount],
    ['avatar', Object.keys(avatar).length ? avatar : undefined],
    ['settings', Object.keys(settings).length ? settings : undefined],
    ['stats', stats],
    ['discoveredFrom', present([['tag', tag], ['region', region], ['language', language]])],
    ['capturedAt', capturedAt],
  ]);
}
