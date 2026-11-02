import { describe, expect, test } from "bun:test";
import { type Attribution, normalizeQuote, parseAttribution } from "./normalize";

const CANONICAL = "the impediment to action advances action";

describe("normalizeQuote", () => {
  const equivalents: Array<[label: string, input: string]> = [
    ["plain", "The impediment to action advances action."],
    ["straight quotes", '"The impediment to action advances action."'],
    ["curly quotes", "\u201CThe impediment to action advances action.\u201D"],
    ["single curly quotes", "\u2018The impediment to action advances action.\u2019"],
    ["guillemets", "\u00ABThe impediment to action advances action.\u00BB"],
    [
      "em dash attribution",
      "\u201CThe impediment to action advances action.\u201D \u2014 Marcus Aurelius",
    ],
    ["hyphen attribution", '"The impediment to action advances action." - Marcus Aurelius'],
    [
      "attribution with source",
      "The impediment to action advances action. - Marcus Aurelius, Meditations",
    ],
    ["tilde attribution", "The impediment to action advances action. ~ Marcus Aurelius"],
    [
      "unspaced em dash attribution",
      "The impediment to action advances action.\u2014Marcus Aurelius",
    ],
    [
      "attribution on new line",
      "The impediment to action advances action.\n\u2014 Marcus Aurelius",
    ],
    ["extra whitespace and newlines", "  The   impediment\n\nto action\tadvances   action.  "],
    ["uppercase", "THE IMPEDIMENT TO ACTION ADVANCES ACTION!"],
    ["emoji", "The impediment to action \u{1F525} advances action. \u{1F64F}\u{1F3FD}\u2728"],
    [
      "ZWJ emoji and flags",
      "\u{1F468}\u200D\u{1F469}\u200D\u{1F467} The impediment to action advances action \u{1F1EC}\u{1F1F7}",
    ],
    [
      "caption with hashtags",
      "\u201CThe impediment to action advances action.\u201D \u2014 Marcus Aurelius\n\n#stoicism #MarcusAurelius #quotes_daily",
    ],
    ["hashtag inside text body", "The impediment to action #stoic advances action"],
    ["full-width characters (NFKC)", "\uFF34he impediment to action advances action\uFF0E"],
  ];

  test.each(equivalents)("%s normalizes to the canonical string", (_label, input) => {
    expect(normalizeQuote(input)).toBe(CANONICAL);
  });

  const cases: Array<[label: string, input: string, expected: string]> = [
    ["curly apostrophe vs straight", "Don\u2019t stop", "dont stop"],
    ["straight apostrophe", "Don't stop", "dont stop"],
    [
      "em dash between words becomes space",
      "Be patient\u2014it will come",
      "be patient it will come",
    ],
    ["en dash between words becomes space", "pages 10\u201312", "pages 10 12"],
    ["spaced hyphen with lowercase tail is not attribution", "wait - and see", "wait and see"],
    ["intra-word hyphen", "a well-known fact", "a well known fact"],
    ["ellipsis", "And yet\u2026 it moves", "and yet it moves"],
    ["accented letters kept", "Caf\u00E9 cr\u00E8me", "caf\u00E9 cr\u00E8me"],
    [
      "non-Latin script kept",
      "\u0393\u03BD\u1FF6\u03B8\u03B9 \u03C3\u03B5\u03B1\u03C5\u03C4\u03CC\u03BD",
      "\u03B3\u03BD\u1FF6\u03B8\u03B9 \u03C3\u03B5\u03B1\u03C5\u03C4\u03CC\u03BD",
    ],
    ["digits kept", "Rule #1: never lose money", "rule 1 never lose money"],
    ["C# is not a hashtag", "I love C#", "i love c"],
    ["hashtag right after punctuation", "Know thyself.#wisdom", "know thyself"],
    ["hashtag right after emoji", "Know thyself \u{1F525}#wisdom", "know thyself"],
    ["adjacent hashtags", "Know thyself #wisdom#quotes", "know thyself"],
    [
      "non-Latin hashtag with combining marks",
      "Know thyself #\u092A\u094D\u0930\u0947\u0930\u0923\u093E",
      "know thyself",
    ],
    ["hashtag after combining mark is not split", "\u0915\u093E#tag", "\u0915\u093E tag"],
    ["emoji that NFKC turns into letters", "Know thyself \u2139\uFE0F", "know thyself"],
    ["trade mark emoji", "Know thyself \u2122\uFE0F", "know thyself"],
    ["emoji glued before a hashtag", "Know thyself\u{1F525}#wisdom", "know thyself"],
    [
      "source dash does not leak into normalized text",
      "Know thyself. \u2014 Socrates, Dialogues \u2013 Book II",
      "know thyself",
    ],
    ["keycap emoji removed", "Know thyself 1\uFE0F\u20E3", "know thyself"],
    ["keycap emoji without selector removed", "Know thyself #\u20E3", "know thyself"],
    ["acute accent used as apostrophe", "Don\u00B4t stop", "dont stop"],
    [
      "unspaced dash in all-caps quote is kept",
      "I THINK\u2014THEREFORE I AM",
      "i think therefore i am",
    ],
    ["empty string", "", ""],
    ["only whitespace", "   \n\t ", ""],
    ["only emoji and hashtags", "\u{1F525} #motivation", ""],
  ];

  test.each(cases)("%s", (_label, input, expected) => {
    expect(normalizeQuote(input)).toBe(expected);
  });
});

describe("parseAttribution", () => {
  const cases: Array<[label: string, input: string, expected: Attribution]> = [
    [
      '"Text" \u2014 Author',
      '"Waste no more time arguing what a good man should be. Be one." \u2014 Marcus Aurelius',
      {
        text: "Waste no more time arguing what a good man should be. Be one.",
        author: "Marcus Aurelius",
      },
    ],
    [
      "curly quotes with em dash",
      "\u201CWe suffer more in imagination than in reality.\u201D\u2014Seneca",
      { text: "We suffer more in imagination than in reality.", author: "Seneca" },
    ],
    [
      "Text ~ Author",
      "Luck is what happens when preparation meets opportunity ~ Seneca",
      { text: "Luck is what happens when preparation meets opportunity", author: "Seneca" },
    ],
    [
      "Text ~Author (no space)",
      "Luck is what happens when preparation meets opportunity ~Seneca",
      { text: "Luck is what happens when preparation meets opportunity", author: "Seneca" },
    ],
    [
      "Text - Author, Book",
      "Associate with people who are likely to improve you. - Seneca, Letters from a Stoic",
      {
        text: "Associate with people who are likely to improve you.",
        author: "Seneca",
        source: "Letters from a Stoic",
      },
    ],
    [
      "en dash with source",
      "The obstacle is the way \u2013 Ryan Holiday, The Obstacle Is the Way",
      {
        text: "The obstacle is the way",
        author: "Ryan Holiday",
        source: "The Obstacle Is the Way",
      },
    ],
    ["double hyphen", "Know thyself -- Socrates", { text: "Know thyself", author: "Socrates" }],
    [
      "attribution on its own line",
      "Know thyself\n\u2014 Socrates",
      { text: "Know thyself", author: "Socrates" },
    ],
    [
      "author with initials",
      "It is our choices that show what we truly are. \u2014 J.K. Rowling",
      { text: "It is our choices that show what we truly are.", author: "J.K. Rowling" },
    ],
    [
      "trailing comma yields no source",
      "Know thyself \u2014 Socrates,",
      { text: "Know thyself", author: "Socrates" },
    ],
    [
      "no attribution",
      "The best revenge is not to be like your enemy.",
      { text: "The best revenge is not to be like your enemy." },
    ],
    [
      "no attribution, surrounding quotes stripped",
      "\u201CThe best revenge is not to be like your enemy.\u201D",
      { text: "The best revenge is not to be like your enemy." },
    ],
    ["intra-word hyphen is not a separator", "A well-known Truth", { text: "A well-known Truth" }],
    [
      "mid-sentence em dash before lowercase clause",
      "Be patient \u2014 it will come",
      { text: "Be patient \u2014 it will come" },
    ],
    [
      "dash followed by a long uppercase clause is not an author",
      "I tried \u2014 And Then I Tried Again And Again Forever",
      { text: "I tried \u2014 And Then I Tried Again And Again Forever" },
    ],
    ["dash with nothing before it", "\u2014 Seneca", { text: "\u2014 Seneca" }],
    ["dash with nothing after it", "Know thyself \u2014", { text: "Know thyself \u2014" }],
    ["empty string", "", { text: "" }],
    ["lone quote mark is not stripped", '"', { text: '"' }],
    ["unbalanced leading quote is kept", '"Know thyself', { text: '"Know thyself' }],
    [
      "surrounding whitespace trimmed",
      "  Know thyself  \u2014  Socrates  ",
      { text: "Know thyself", author: "Socrates" },
    ],
    [
      "name particles allowed in author",
      "Even the darkest night will end \u2014 Victor Hugo, Les Mis\u00E9rables",
      {
        text: "Even the darkest night will end",
        author: "Victor Hugo",
        source: "Les Mis\u00E9rables",
      },
    ],
    [
      "lowercase name particle in author",
      "Be the change \u2014 Ludwig van Beethoven",
      { text: "Be the change", author: "Ludwig van Beethoven" },
    ],
    [
      "capitalized clause with lowercase words is not an author",
      "Be patient \u2014 It will come",
      { text: "Be patient \u2014 It will come" },
    ],
    [
      "unspaced dash between words is not a separator",
      "I think\u2014Therefore I Am",
      { text: "I think\u2014Therefore I Am" },
    ],
    [
      "all-caps quote with unspaced dash",
      "I THINK\u2014THEREFORE I AM",
      { text: "I THINK\u2014THEREFORE I AM" },
    ],
    [
      "all-caps quote with spaced dash is ambiguous, so kept",
      "I THINK \u2014 THEREFORE I AM",
      { text: "I THINK \u2014 THEREFORE I AM" },
    ],
    [
      "all-caps quote with attribution after closing punctuation",
      "WASTE NO MORE TIME. \u2014 MARCUS AURELIUS",
      { text: "WASTE NO MORE TIME.", author: "MARCUS AURELIUS" },
    ],
    [
      "all-caps quote with attribution after closing quote",
      "\u201CKNOW THYSELF\u201D \u2014 SOCRATES",
      { text: "KNOW THYSELF", author: "SOCRATES" },
    ],
    [
      "separator inside the source belongs to the source",
      "Know thyself. \u2014 Socrates, Dialogues \u2013 Book II",
      { text: "Know thyself.", author: "Socrates", source: "Dialogues \u2013 Book II" },
    ],
    [
      "author containing a separator is rejected",
      "Know thyself \u2014 Plato~Socrates",
      { text: "Know thyself \u2014 Plato~Socrates" },
    ],
    [
      "earlier dash clause is skipped when its author is invalid",
      "I came \u2014 then I left \u2014 Julius Caesar, Commentaries \u2013 Book I",
      {
        text: "I came \u2014 then I left",
        author: "Julius Caesar",
        source: "Commentaries \u2013 Book I",
      },
    ],
  ];

  test.each(cases)("%s", (_label, input, expected) => {
    expect(parseAttribution(input)).toEqual(expected);
  });

  test("omits author/source keys when absent", () => {
    const result = parseAttribution("No attribution here");
    expect(Object.keys(result)).toEqual(["text"]);
  });
});
