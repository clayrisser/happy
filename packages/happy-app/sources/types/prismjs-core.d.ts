/**
 * `@types/prismjs` types the browser bundle entry only. We import the bare
 * tokenizer instead (DROVE-159), so declare it against the same shapes.
 */
declare module 'prismjs/components/prism-core' {
    import type { Grammar, Languages, Token, TokenStream } from 'prismjs';

    const Prism: {
        languages: Languages;
        tokenize(text: string, grammar: Grammar): TokenStream;
        Token: typeof Token;
    };
    export default Prism;
}
