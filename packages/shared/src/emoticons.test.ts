import { describe, expect, it } from 'vitest';
import { EMOTICONS, replaceFinalEmoticon, replaceTypedEmoticon } from './emoticons.ts';

/** Types `ch` at the end of `prev`, as a keyboard would, and returns what the text box shows. */
const typeAtEnd = (prev: string, ch: string) => replaceTypedEmoticon(prev, prev + ch, prev.length + 1)?.text ?? prev + ch;

describe('emoticons as you type', () => {
  it('turns a finished emoticon into the emoji', () => {
    expect(typeAtEnd(':)', ' ')).toBe('🙂 ');
    expect(typeAtEnd('hi :-)', ' ')).toBe('hi 🙂 ');
    expect(typeAtEnd('love you <3', ' ')).toBe('love you ❤️ ');
    expect(typeAtEnd('ok </3', ' ')).toBe('ok 💔 ');
    expect(typeAtEnd('lol XD', ' ')).toBe('lol 😆 ');
    expect(typeAtEnd('lol xD', ' ')).toBe('lol 😆 ');
    expect(typeAtEnd('hmm :/', ' ')).toBe('hmm 😕 ');
    expect(typeAtEnd('grr >:(', ' ')).toBe('grr 😠 ');
    expect(typeAtEnd('aw :’(', ' ')).toBe('aw 😢 ');
    expect(typeAtEnd("aw :'(", ' ')).toBe('aw 😢 ');
    expect(typeAtEnd('yay \\o/', ' ')).toBe('yay 🙌 ');
    expect(typeAtEnd('hey o/', ' ')).toBe('hey 👋 ');
    expect(typeAtEnd('^_^', ' ')).toBe('😊 ');
  });

  it('every emoticon in the list converts', () => {
    for (const [text, emoji] of Object.entries(EMOTICONS)) expect(typeAtEnd(text, ' ')).toBe(`${emoji} `);
  });

  it('finishes on a new line or a closing mark too', () => {
    expect(typeAtEnd('see you :)', '\n')).toBe('see you 🙂\n');
    expect(typeAtEnd('see you :D', '!')).toBe('see you 😄!');
    expect(typeAtEnd('fine :|', '.')).toBe('fine 😐.');
    expect(typeAtEnd('really :O', '?')).toBe('really 😮?');
    expect(typeAtEnd(':P', ',')).toBe('😛,');
    expect(typeAtEnd(':P', '\t')).toBe('😛\t');
  });

  it('puts the caret right after the typed character', () => {
    // ":-)" is three characters, "🙂" two: everything after moves back one.
    expect(replaceTypedEmoticon('hi :-)', 'hi :-) ', 7)).toEqual({ text: 'hi 🙂 ', caret: 6 });
    expect(replaceTypedEmoticon('<3', '<3 ', 3)).toEqual({ text: '❤️ ', caret: 3 });
  });

  it('works in the middle of the text', () => {
    // "hi :) there" with the caret after ":)", typing a space.
    expect(replaceTypedEmoticon('hi :-)there', 'hi :-) there', 7)).toEqual({ text: 'hi 🙂 there', caret: 6 });
    // The same, with the caret worked out from the two texts.
    expect(replaceTypedEmoticon('hi :-)there', 'hi :-) there')).toEqual({ text: 'hi 🙂 there', caret: 6 });
  });

  it('works out where the character went', () => {
    expect(replaceTypedEmoticon(':)', ':) ')).toEqual({ text: '🙂 ', caret: 3 });
    // A second space after an emoticon left as text: the space went at the end, after the first one.
    expect(replaceTypedEmoticon(':) ', ':)  ')).toBeNull();
    expect(replaceTypedEmoticon('ok :D', 'ok :D!')).toEqual({ text: 'ok 😄!', caret: 6 });
  });

  it('leaves emoticon-like text inside words, times and links alone', () => {
    for (const text of ['http://x', 'https:/', 'a:b', 'a:)', '12:30', '1:1', 'std::vector', 'C:/', 'hey:)', ':))', '(:', 'x<3', 'ab^^', '8)', 'B)', ':', '<']) {
      expect(typeAtEnd(text, ' ')).toBe(`${text} `);
    }
    expect(typeAtEnd('see http://x.com/a:/', ' ')).toBe('see http://x.com/a:/ ');
    expect(typeAtEnd('at 12:30', '.')).toBe('at 12:30.');
  });

  it('only finishes on a boundary', () => {
    expect(typeAtEnd(':', ')')).toBe(':)');
    expect(typeAtEnd(':)', ')')).toBe(':))');
    expect(typeAtEnd(':)', 'a')).toBe(':)a');
    expect(typeAtEnd('<3', ':')).toBe('<3:');
  });

  it('never inside code', () => {
    expect(typeAtEnd('try `:)', ' ')).toBe('try `:) ');
    expect(typeAtEnd('try ` :)', ' ')).toBe('try ` :) ');
    expect(typeAtEnd('```\nx = 1 :)', ' ')).toBe('```\nx = 1 :) ');
    // After the code closes, it converts again.
    expect(typeAtEnd('`a` :)', ' ')).toBe('`a` 🙂 ');
    expect(typeAtEnd('```\ncode\n``` :)', ' ')).toBe('```\ncode\n``` 🙂 ');
  });

  it('only changes the emoticon just finished, not others in the text', () => {
    // An earlier ":)" left as text (the person undid it) stays; only the new one converts.
    expect(typeAtEnd(':) and :D', ' ')).toBe(':) and 😄 ');
    expect(replaceTypedEmoticon(':) and', ':) and ')).toBeNull();
  });

  it('leaves pastes, deletions and replacements alone', () => {
    expect(replaceTypedEmoticon('', ':) ')).toBeNull();
    expect(replaceTypedEmoticon('hi', 'hi :) ')).toBeNull();
    // Backspace right after a change: just editing.
    expect(replaceTypedEmoticon('🙂 ', '🙂')).toBeNull();
    expect(replaceTypedEmoticon('🙂', '')).toBeNull();
    // Same length, a word swapped by the keyboard.
    expect(replaceTypedEmoticon('teh :)', 'the :)')).toBeNull();
    // A caret that doesn't match the change.
    expect(replaceTypedEmoticon(':)', ':) ', 1)).toBeNull();
    expect(replaceTypedEmoticon(':)', ':) ', 0)).toBeNull();
  });

  it('keeps the rest of the text, emoji and all', () => {
    expect(typeAtEnd('🎉 party :D', ' ')).toBe('🎉 party 😄 ');
    expect(replaceTypedEmoticon('🎉 :)x', '🎉 :) x')).toEqual({ text: '🎉 🙂 x', caret: 6 });
  });
});

describe('the last emoticon when sending', () => {
  it('turns an emoticon at the very end into the emoji', () => {
    expect(replaceFinalEmoticon(':)')).toBe('🙂');
    expect(replaceFinalEmoticon('nice :D')).toBe('nice 😄');
    expect(replaceFinalEmoticon('line one\n<3')).toBe('line one\n❤️');
  });

  it('leaves everything else alone', () => {
    expect(replaceFinalEmoticon('')).toBe('');
    expect(replaceFinalEmoticon('nice :) ')).toBe('nice :) ');
    expect(replaceFinalEmoticon(':) nice')).toBe(':) nice');
    expect(replaceFinalEmoticon('at 12:30')).toBe('at 12:30');
    expect(replaceFinalEmoticon('http://x')).toBe('http://x');
    expect(replaceFinalEmoticon('`:)')).toBe('`:)');
  });
});
