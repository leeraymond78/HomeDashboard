const STORAGE_KEY = 'homedashboard-locale';
export const LOCALE_CHANGE = 'localechange';

/** @type {Record<string, string>} */
const GROUP_TITLES_EN = {
  'ゴールドコースト・九竜行': 'Gold Coast → Kowloon',
  '高速道路インター・九竜行': 'TM BB Interchange → Kowloon',
  '深圳灣口岸': 'Shenzhen Bay Port',
  'TSTから帰宅': 'Home from TST',
  '高速道路インター・屯門行': 'TM BB Interchange → Tuen Mun',
  'ゴールドコースト・屯門行': 'Gold Coast → Tuen Mun',
  '屯門タウンセンター': 'Tuen Mun Town Plaza',
  '新都プラーザ': 'New Town Commercial Arcade',
  'ヴィシーティー前': 'V City',
  '市場前': 'San Hui Market',
};

/** @type {Record<'ja' | 'en', Record<string, string>>} */
const MESSAGES = {
  ja: {
    'app.title': 'ゴールドコースト',
    'app.description': 'バス・小巴・接駁・天気。ゴールドコースト周辺の出かけ情報',
    'location.prompt': '近くの停留所を表示（位置情報を許可）',
    'location.denied': '設定で位置情報を許可してください',
    'location.unavailable': '位置情報を取得できませんでした。もう一度お試しください',
    'location.unsupported': 'この端末では位置情報を利用できません',
    'location.insecure': 'HTTPS接続が必要です（http://192.168… では位置情報を利用できません）',
    'search.open': 'バス番号で検索',
    'refresh': '更新',
    'loading': '読み込み中…',
    'error.data': 'データを取得できませんでした',
    'error.config': '設定ファイルを読み込めません',
    'empty.etas': '到着予定のバスはありません',
    'showMore': 'もっと見る（あと{count}本）',
    'eta.stopsLeft': 'あと{count}駅',
    'remark.scheduled': '時刻通り',
    'remark.awaitingDepart': '発車待ち',
    'remark.trafficDelay': '渋滞により、到着時間が若干遅れる場合があります。',
    'express.airport': '空港',
    'express.express': '特急',
    'express.local': '各停',
    'express.semiExpress': '準急',
    'express.shuttle': '穿梭',
    'express.normal': 'ﾌﾂｳ',
    'theme.lcd': 'LCDモード',
    'theme.led': 'LEDモード',
    'theme.toDark': 'ダークモードに切替',
    'theme.toLcd': 'LCDライトモードに切替',
    'locale.toEn': 'Switch to English',
    'locale.toJa': '日本語に切替',
    'locale.en': 'EN',
    'locale.ja': '日本語',
    'bus.back': '戻る',
    'bus.timetable': '時刻表',
    'bus.flipBound': '方向切替',
    'bus.locate': '現在地',
    'bus.notFound': '路線が見つかりません',
    'bus.invalidLink': '無効なリンクです',
    'bus.loadError': '読み込みエラー',
    'bus.noStops': '停留所データがありません',
    'bus.noTimetable': '時刻表データがありません',
    'bus.noInfo': '情報なし',
    'bus.inTransit': '走行中',
    'bus.arrivingAt': '{stop}へ到着',
    'bus.late': '遅刻',
    'bus.arrived': '到着',
    'bus.minutes': '{count}分',
    'bus.headwayMinutes': '每{count}分',
    'bus.badge.current': '現在',
    'bus.badge.closest': '最寄り',
    'bus.badge.next': '次は',
    'bus.fareHoliday': '祝日 {amount}',
    'bus.vehicle': 'バス{index}',
    'bus.timetable.weekday': '平日',
    'bus.timetable.saturday': '土曜',
    'bus.timetable.sundayHoliday': '日曜・祝日',
    'bus.timetable.monThu': '月〜木曜',
    'bus.timetable.friday': '金曜',
    'bus.timetable.satShort': '土曜',
    'bus.timetable.sunHolidayShort': '日祝',
    'bus.timetable.day.mon': '月',
    'bus.timetable.day.tue': '火',
    'bus.timetable.day.wed': '水',
    'bus.timetable.day.thu': '木',
    'bus.timetable.day.fri': '金',
    'bus.timetable.day.sat': '土',
    'bus.timetable.day.sun': '日',
    'bus.timetable.loadError': '時刻表データを読み込めません: {url}',
    'bus.close': '閉じる',
    'bus.title': '路線詳細',
    'search.title': '路線検索',
    'search.results': '検索結果',
    'search.keyboard': '路線番号キーボード',
    'search.placeholder': '路線番号を入力',
    'search.hint.empty': '番号を入力すると路線が表示されます',
    'search.hint.none': '該当する路線がありません',
    'search.hint.loadFail': '路線データの読み込みに失敗しました',
    'search.load.cache': 'キャッシュから読み込み中…',
    'search.load.routes': '路線データを読み込み中…',
    'search.dest': '{dest}行き',
    'search.special': '特別便',
    'search.clear': '全消',
    'search.delete': '削除',
    'search.openFail': '路線を開けませんでした',
    'search.error.noStop': '停留所が見つかりません',
    'search.error.incomplete': '路線情報が不足しています',
    'search.error.unsupported': '未対応の路線です',
    'search.label': '{route} 往{dest}',
    'operator.kmb': '九巴',
    'operator.nwfb': '城巴',
    'operator.mtr': '港鐵',
    'operator.gmb': '小巴',
    'weather.title': '天氣',
    'weather.loading': '載入中…',
    'weather.unavailable': '取得できません',
    'weather.error': '天気資料の取得できません',
    'weather.noWarnings': '無生效警告',
    'weather.humidity': '相對濕度',
    'weather.rainfall': '降雨量',
    'weather.todayHighLow': '今日最高／最低',
    'weather.tomorrow': '明天',
    'weather.activeWarnings': '生效警告',
    'weather.hkoApp': '開啟「我的天文台」App 查看更多',
    'weather.locationGps': '依您目前位置，最近氣象站為{station}（約 {distance}）',
    'weather.locationFallback': '無法取得定位，使用預設氣象站（{station}）',
    'weather.humidityFrom': '濕度資料來自{station}',
    'weather.rainfallFrom': '雨量資料來自{station}',
    'weather.typhoon': '熱帶氣旋：{info}',
    'weather.rainstorm': '暴雨警告：{level}',
    'weather.typhoonSignal': '颱風信號：{level}',
    'weather.rain.yellow': '黃雨',
    'weather.rain.red': '紅雨',
    'weather.rain.black': '黑雨',
    'weather.thunderstorm': '雷暴',
    'error.mtrStops': 'MTRバス停留所データを読み込めません',
    'error.fareDb': '路線データの取得に失敗しました',
    'offline': 'オフラインです。ネットワーク接続を確認してください。',
  },
  en: {
    'app.title': 'Gold Coast',
    'app.description': 'Buses, minibuses, shuttles & weather around Gold Coast',
    'location.prompt': 'Show nearby stops (allow location)',
    'location.denied': 'Allow location in Settings',
    'location.unavailable': 'Could not get location. Please try again',
    'location.unsupported': 'Location is not available on this device',
    'location.insecure': 'HTTPS required (location unavailable on http://192.168…)',
    'search.open': 'Search by route number',
    'refresh': 'Refresh',
    'loading': 'Loading…',
    'error.data': 'Could not load data',
    'error.config': 'Could not load config',
    'empty.etas': 'No buses arriving',
    'showMore': 'Show more ({count} more)',
    'eta.stopsLeft': '{count} stops',
    'remark.scheduled': 'On schedule',
    'remark.awaitingDepart': 'At depot',
    'remark.trafficDelay': 'Traffic may cause slight delays.',
    'express.airport': 'Airport',
    'express.express': 'Express',
    'express.local': 'Local',
    'express.semiExpress': 'Semi-express',
    'express.shuttle': 'Shuttle',
    'express.normal': 'Regular',
    'theme.lcd': 'LCD mode',
    'theme.led': 'LED mode',
    'theme.toDark': 'Switch to dark mode',
    'theme.toLcd': 'Switch to LCD light mode',
    'locale.toEn': 'Switch to English',
    'locale.toJa': 'Switch to Japanese',
    'locale.en': 'EN',
    'locale.ja': '日本語',
    'bus.back': 'Back',
    'bus.timetable': 'Timetable',
    'bus.flipBound': 'Reverse direction',
    'bus.locate': 'My location',
    'bus.notFound': 'Route not found',
    'bus.invalidLink': 'Invalid link',
    'bus.loadError': 'Load error',
    'bus.noStops': 'No stop data',
    'bus.noTimetable': 'No timetable data',
    'bus.noInfo': 'No info',
    'bus.inTransit': 'In transit',
    'bus.arrivingAt': 'Arriving at {stop}',
    'bus.late': 'Late',
    'bus.arrived': 'Arrived',
    'bus.minutes': '{count} min',
    'bus.headwayMinutes': 'Every {count} minutes',
    'bus.badge.current': 'Here',
    'bus.badge.closest': 'Nearest',
    'bus.badge.next': 'Next',
    'bus.fareHoliday': 'Holiday {amount}',
    'bus.vehicle': 'Bus {index}',
    'bus.timetable.weekday': 'Weekdays',
    'bus.timetable.saturday': 'Saturday',
    'bus.timetable.sundayHoliday': 'Sun & public holidays',
    'bus.timetable.monThu': 'Mon–Thu',
    'bus.timetable.friday': 'Friday',
    'bus.timetable.satShort': 'Sat',
    'bus.timetable.sunHolidayShort': 'Sun/PH',
    'bus.timetable.day.mon': 'Mon',
    'bus.timetable.day.tue': 'Tue',
    'bus.timetable.day.wed': 'Wed',
    'bus.timetable.day.thu': 'Thu',
    'bus.timetable.day.fri': 'Fri',
    'bus.timetable.day.sat': 'Sat',
    'bus.timetable.day.sun': 'Sun',
    'bus.timetable.loadError': 'Could not load timetable: {url}',
    'bus.close': 'Close',
    'bus.title': 'Route detail',
    'search.title': 'Route search',
    'search.results': 'Search results',
    'search.keyboard': 'Route number keyboard',
    'search.placeholder': 'Enter route number',
    'search.hint.empty': 'Enter a number to see routes',
    'search.hint.none': 'No matching routes',
    'search.hint.loadFail': 'Failed to load route data',
    'search.load.cache': 'Loading from cache…',
    'search.load.routes': 'Loading route data…',
    'search.dest': 'To {dest}',
    'search.special': 'Special',
    'search.clear': 'Clear',
    'search.delete': 'Delete',
    'search.openFail': 'Could not open route',
    'search.error.noStop': 'Stop not found',
    'search.error.incomplete': 'Incomplete route info',
    'search.error.unsupported': 'Unsupported route',
    'search.label': '{route} to {dest}',
    'operator.kmb': 'KMB',
    'operator.nwfb': 'Citybus',
    'operator.mtr': 'MTR Bus',
    'operator.gmb': 'GMB',
    'weather.title': 'Weather',
    'weather.loading': 'Loading…',
    'weather.unavailable': 'Unavailable',
    'weather.error': 'Weather data temporarily unavailable',
    'weather.noWarnings': 'No active warnings',
    'weather.humidity': 'Humidity',
    'weather.rainfall': 'Rainfall',
    'weather.todayHighLow': 'Today high / low',
    'weather.tomorrow': 'Tomorrow',
    'weather.activeWarnings': 'Active warnings',
    'weather.hkoApp': 'Open MyObservatory app for more',
    'weather.locationGps': 'Nearest station to you: {station} (about {distance})',
    'weather.locationFallback': 'Location unavailable; using default station ({station})',
    'weather.humidityFrom': 'Humidity from {station}',
    'weather.rainfallFrom': 'Rainfall from {station}',
    'weather.typhoon': 'Tropical cyclone: {info}',
    'weather.rainstorm': 'Rainstorm warning: {level}',
    'weather.typhoonSignal': 'Typhoon signal: {level}',
    'weather.rain.yellow': 'Amber rain',
    'weather.rain.red': 'Red rain',
    'weather.rain.black': 'Black rain',
    'weather.thunderstorm': 'Thunderstorm',
    'error.mtrStops': 'Could not load MTR buses stop data',
    'error.fareDb': 'Could not load route data',
    'offline': 'You are offline. Check your network connection.',
  },
};

const AWAITING_DEPART_RAW = new Set(['未開出', '原定班次']);

/** @returns {'ja' | 'en'} */
export function getLocale() {
  return document.documentElement.dataset.locale === 'en' ? 'en' : 'ja';
}

export function isEnglish() {
  return getLocale() === 'en';
}

/** @param {Record<string, string | number>} [params] */
export function t(key, params) {
  const template = MESSAGES[getLocale()][key] ?? MESSAGES.ja[key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ''));
}

/** @param {string | undefined | null} zh @param {string | undefined | null} en */
export function pickLocalized(zh, en) {
  if (isEnglish() && en) return en;
  return zh ?? en ?? '';
}

/** @param {string} title */
export function groupTitle(title) {
  if (isEnglish()) return GROUP_TITLES_EN[title] ?? title;
  return title;
}

export function isAwaitingDepartRemark(remark) {
  if (!remark) return false;
  if (remark === t('remark.awaitingDepart')) return true;
  return AWAITING_DEPART_RAW.has(remark) || remark === '発車待ち';
}

/** @param {Date} date */
export function formatLocaleTime(date) {
  const locale = isEnglish() ? 'en-GB' : 'ja-JP';
  return date.toLocaleTimeString(locale, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

/** @param {string | undefined} iso */
export function formatLocaleDateTime(iso) {
  if (!iso) return '--';
  try {
    const locale = isEnglish() ? 'en-GB' : 'zh-HK';
    return new Date(iso).toLocaleString(locale, {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  } catch {
    return '--';
  }
}

/** @param {'ja' | 'en'} locale */
export function applyLocale(locale) {
  const next = locale === 'en' ? 'en' : 'ja';
  document.documentElement.lang = next;
  document.documentElement.dataset.locale = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* ignore */
  }
  updateLocaleButton();
  applyStaticI18n();
  window.dispatchEvent(new CustomEvent(LOCALE_CHANGE));
}

export function toggleLocale() {
  applyLocale(getLocale() === 'en' ? 'ja' : 'en');
}

function updateLocaleButton() {
  const btn = document.getElementById('locale-btn');
  if (!btn) return;
  const en = isEnglish();
  btn.setAttribute('aria-pressed', en ? 'true' : 'false');
  btn.setAttribute('aria-label', en ? t('locale.toJa') : t('locale.toEn'));
  btn.textContent = en ? t('locale.ja') : t('locale.en');
}

export function applyStaticI18n(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    if (key) el.textContent = t(key);
  });
  root.querySelectorAll('[data-i18n-aria]').forEach((el) => {
    const key = el.getAttribute('data-i18n-aria');
    if (key) el.setAttribute('aria-label', t(key));
  });
  root.querySelectorAll('[data-i18n-title]').forEach((el) => {
    const key = el.getAttribute('data-i18n-title');
    if (key) el.setAttribute('title', t(key));
  });
  const pageTitle = document.documentElement.dataset.pageTitle;
  if (pageTitle) document.title = t(pageTitle);
}

export function initLocale() {
  applyLocale(getLocale());
}

export function initLocaleToggle() {
  document.getElementById('locale-btn')?.addEventListener('click', toggleLocale);
}
