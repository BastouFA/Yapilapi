import { describe, expect, it } from 'vitest';
import { detectLanguage } from './language-detect.ts';
import { SUPPORTED_LOCALES } from './i18n-core.ts';
import { autonym, byAutonym, isTranslationLanguage, TRANSLATION_LANGUAGES } from './translation.ts';

describe('language detection', () => {
  it('tells the app’s languages in other writing systems by their script', () => {
    expect(detectLanguage('आज मौसम बहुत अच्छा है, दोस्तों के साथ घूमने चलते हैं')).toBe('hi');
    expect(detectLanguage('আজ আবহাওয়া খুব সুন্দর, বন্ধুদের সাথে ঘুরতে যাব')).toBe('bn');
    expect(detectLanguage('Сегодня отличная погода, гуляем с друзьями')).toBe('ru');
    expect(detectLanguage('今日はとてもいい天気ですね。友達と出かけます')).toBe('ja');
    expect(detectLanguage('今天天气很好，我们和朋友一起出去玩')).toBe('zh');
    expect(detectLanguage('오늘 날씨가 정말 좋아요. 친구들이랑 놀러 가요')).toBe('ko');
    expect(detectLanguage('ዛሬ አየሩ በጣም ጥሩ ነው፣ ከጓደኞቼ ጋር እወጣለሁ')).toBe('am');
    expect(detectLanguage('آج موسم بہت اچھا ہے، دوستوں کے ساتھ باہر چلتے ہیں')).toBe('ur');
  });

  it('tells the Latin-script ones by their words and letters', () => {
    expect(detectLanguage('Heute ist das Wetter sehr gut und wir sind mit Freunden unterwegs')).toBe('de');
    expect(detectLanguage('Oggi è una bella giornata, sono con i miei amici')).toBe('it');
    expect(detectLanguage('Bugün hava çok güzel, arkadaşlarımla dışarı çıkıyorum')).toBe('tr');
    expect(detectLanguage('Hari ini cuacanya sangat bagus, saya pergi dengan teman')).toBe('id');
    expect(detectLanguage('Hôm nay trời rất đẹp, tôi đi chơi với bạn bè')).toBe('vi');
    expect(detectLanguage('Ụtụtụ ọma, kedu ka ị mere taa? Daalụ nne m')).toBe('ig');
    expect(detectLanguage('Sawubona mngane wami, unjani namhlanje? Ngiyabonga kakhulu')).toBe('zu');
  });

  it('can translate into and out of every language the app speaks', () => {
    expect(SUPPORTED_LOCALES.filter((l) => !isTranslationLanguage(l))).toEqual([]);
    expect(new Set(TRANSLATION_LANGUAGES.map((l) => l.code)).size).toBe(TRANSLATION_LANGUAGES.length);
  });
});

describe('language names', () => {
  it('names each language in itself', () => {
    expect(['zh', 'hi', 'bn', 'ru', 'ja', 'de', 'id', 'tr', 'ko', 'it', 'vi', 'ur', 'am', 'ig', 'zu'].map(autonym)).toEqual([
      '中文',
      'हिन्दी',
      'বাংলা',
      'Русский',
      '日本語',
      'Deutsch',
      'Bahasa Indonesia',
      'Türkçe',
      '한국어',
      'Italiano',
      'Tiếng Việt',
      'اردو',
      'አማርኛ',
      'Igbo',
      'isiZulu',
    ]);
    expect(autonym('xx')).toBe('xx');
  });

  it('lists the app’s languages by their own names, Latin letters first', () => {
    expect(byAutonym(SUPPORTED_LOCALES).map(autonym)).toEqual([
      'Bahasa Indonesia',
      'Deutsch',
      'English',
      'Español',
      'Français',
      'Hausa',
      'Igbo',
      'isiZulu',
      'Italiano',
      'Kiswahili',
      'Português',
      'Tiếng Việt',
      'Türkçe',
      'Yorùbá',
      'Русский',
      'اردو',
      'العربية',
      'हिन्दी',
      'বাংলা',
      'አማርኛ',
      '中文',
      '日本語',
      '한국어',
    ]);
  });
});
