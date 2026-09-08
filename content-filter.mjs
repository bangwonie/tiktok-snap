const vnRegion = value => /^(vn|vnm|vietnam|viet nam)$/i.test(String(value ?? '').trim());
const viLanguage = value => /^vi(?:[-_]|$)/i.test(String(value ?? '').trim());
const vnText = value => /[ăĂưƯơƠđĐạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/u.test(String(value ?? '').normalize('NFC')) ||
  /(?:^|[^a-z])(?:vietnam|viet\s+nam|tiktokvn|tiktokvietnam|xuhuong|xuhuongtiktok)(?:$|[^a-z])/i.test(String(value ?? ''));

export function excludedSource(source) {
  return vnRegion(source.region) || viLanguage(source.lang) || vnText(source.tag);
}

// These are content signals, not verified creator nationality.
export function vietnamReason(item) {
  const author = typeof item.author === 'object' && item.author ? item.author : {};
  if ([item.region, item.country, item.countryCode, author.region, author.country, author.countryCode].some(vnRegion)) return 'region-vn';
  if ([item.language, item.textLanguage, item.descLanguage, author.language].some(viLanguage)) return 'language-vi';
  const text = [item.desc, item.caption, author.signature, author.bio,
    ...(item.textExtra || []).map(entry => entry.hashtagName)].filter(Boolean).join(' ');
  return vnText(text) ? 'vietnamese-content-signal' : null;
}
