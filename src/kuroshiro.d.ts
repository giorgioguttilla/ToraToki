declare module 'kuroshiro' {
  interface KuroshiroUtil {
    isKanji(char: string): boolean;
    hasKanji(value: string): boolean;
    hasJapanese(value: string): boolean;
    kanaToHiragna(value: string): string;
  }

  interface KuroshiroStatic {
    Util: KuroshiroUtil;
  }

  const Kuroshiro: KuroshiroStatic;

  export default Kuroshiro;
}
