import { useState, useRef, useEffect, useMemo } from 'react';

// ── Emoji data ────────────────────────────────────────────────────────────────
// Curated set of popular emojis organized by category.
// Each entry: [emoji, short search term].

const CATEGORIES = [
  {
    id: 'smileys',
    label: 'Smileys',
    icon: '😀',
    emojis: [
      ['😀', 'grinning'], ['😃', 'smiley'], ['😄', 'smile'], ['😁', 'grin'], ['😆', 'laughing'],
      ['😅', 'sweat smile'], ['🤣', 'rofl'], ['😂', 'joy'], ['🙂', 'slightly smiling'],
      ['😉', 'wink'], ['😊', 'blush'], ['😇', 'innocent'], ['🥰', 'love face'],
      ['😍', 'heart eyes'], ['🤩', 'star struck'], ['😘', 'kissing heart'],
      ['😋', 'yum'], ['🤔', 'thinking'], ['🤗', 'hugging'], ['🤫', 'shushing'],
      ['😎', 'sunglasses'], ['🤓', 'nerd'], ['🧐', 'monocle'], ['😏', 'smirk'],
      ['🫡', 'salute'], ['🫠', 'melting'], ['🥳', 'party face'], ['😴', 'sleeping'],
      ['🤯', 'mind blown'], ['🥺', 'pleading'], ['😤', 'huffing'], ['👻', 'ghost'],
    ],
  },
  {
    id: 'animals',
    label: 'Animals',
    icon: '🐱',
    emojis: [
      ['🐶', 'dog'], ['🐱', 'cat'], ['🐭', 'mouse'], ['🐹', 'hamster'], ['🐰', 'rabbit'],
      ['🦊', 'fox'], ['🐻', 'bear'], ['🐼', 'panda'], ['🐨', 'koala'], ['🐯', 'tiger'],
      ['🦁', 'lion'], ['🐮', 'cow'], ['🐷', 'pig'], ['🐸', 'frog'], ['🐵', 'monkey'],
      ['🐔', 'chicken'], ['🐧', 'penguin'], ['🐦', 'bird'], ['🦅', 'eagle'], ['🦉', 'owl'],
      ['🦇', 'bat'], ['🐺', 'wolf'], ['🐗', 'boar'], ['🐴', 'horse'], ['🦄', 'unicorn'],
      ['🐝', 'bee'], ['🐛', 'bug'], ['🦋', 'butterfly'], ['🐙', 'octopus'], ['🦈', 'shark'],
      ['🐬', 'dolphin'], ['🐳', 'whale'], ['🦭', 'seal'], ['🐢', 'turtle'], ['🦎', 'lizard'],
      ['🐍', 'snake'], ['🦖', 'dinosaur'], ['🦕', 'sauropod'],
    ],
  },
  {
    id: 'nature',
    label: 'Nature',
    icon: '🌿',
    emojis: [
      ['🌸', 'cherry blossom'], ['🌹', 'rose'], ['🌻', 'sunflower'], ['🌺', 'hibiscus'],
      ['🌷', 'tulip'], ['🌱', 'seedling'], ['🌿', 'herb'], ['🍀', 'four leaf clover'],
      ['🍁', 'maple leaf'], ['🌵', 'cactus'], ['🌲', 'evergreen'], ['🌳', 'tree'],
      ['🍄', 'mushroom'], ['🌊', 'wave'], ['🔥', 'fire'], ['⭐', 'star'],
      ['🌙', 'moon'], ['☀️', 'sun'], ['🌈', 'rainbow'], ['❄️', 'snowflake'],
      ['⚡', 'lightning'], ['💧', 'droplet'], ['🪨', 'rock'], ['💎', 'gem'],
    ],
  },
  {
    id: 'food',
    label: 'Food',
    icon: '🍕',
    emojis: [
      ['🍎', 'apple'], ['🍊', 'orange'], ['🍋', 'lemon'], ['🍇', 'grapes'], ['🍓', 'strawberry'],
      ['🫐', 'blueberry'], ['🍑', 'peach'], ['🍒', 'cherry'], ['🥑', 'avocado'], ['🌶️', 'pepper'],
      ['🍕', 'pizza'], ['🍔', 'burger'], ['🌮', 'taco'], ['🍜', 'ramen'], ['🍣', 'sushi'],
      ['🍩', 'donut'], ['🍪', 'cookie'], ['🎂', 'cake'], ['🧁', 'cupcake'],
      ['☕', 'coffee'], ['🍵', 'tea'], ['🧃', 'juice box'], ['🍺', 'beer'],
    ],
  },
  {
    id: 'objects',
    label: 'Objects',
    icon: '💡',
    emojis: [
      ['💡', 'lightbulb'], ['🔧', 'wrench'], ['🔨', 'hammer'], ['⚙️', 'gear'], ['🔑', 'key'],
      ['🗝️', 'old key'], ['🔒', 'lock'], ['📎', 'paperclip'], ['📌', 'pin'],
      ['✏️', 'pencil'], ['📝', 'memo'], ['📚', 'books'], ['📖', 'book'],
      ['💻', 'laptop'], ['🖥️', 'desktop'], ['⌨️', 'keyboard'], ['🖱️', 'mouse'],
      ['📱', 'phone'], ['🎧', 'headphones'], ['🎮', 'game controller'], ['🕹️', 'joystick'],
      ['🔬', 'microscope'], ['🔭', 'telescope'], ['🧪', 'test tube'], ['🧲', 'magnet'],
      ['🛡️', 'shield'], ['⚔️', 'swords'], ['🏹', 'bow'], ['🪄', 'magic wand'],
      ['🎯', 'bullseye'], ['🧩', 'puzzle'], ['🎲', 'dice'], ['🏆', 'trophy'],
    ],
  },
  {
    id: 'symbols',
    label: 'Symbols',
    icon: '💜',
    emojis: [
      ['❤️', 'red heart'], ['🧡', 'orange heart'], ['💛', 'yellow heart'], ['💚', 'green heart'],
      ['💙', 'blue heart'], ['💜', 'purple heart'], ['🖤', 'black heart'], ['🤍', 'white heart'],
      ['💯', 'hundred'], ['✅', 'check'], ['❌', 'cross'], ['⚠️', 'warning'],
      ['🚀', 'rocket'], ['🎉', 'party'], ['🎊', 'confetti'], ['✨', 'sparkles'],
      ['💫', 'dizzy star'], ['🌟', 'glowing star'], ['💥', 'boom'], ['💢', 'anger'],
      ['🔴', 'red circle'], ['🟢', 'green circle'], ['🔵', 'blue circle'], ['🟡', 'yellow circle'],
      ['🟣', 'purple circle'], ['⬛', 'black square'], ['⬜', 'white square'],
      ['♻️', 'recycle'], ['🏴‍☠️', 'pirate flag'], ['🏳️‍🌈', 'rainbow flag'],
    ],
  },
  {
    id: 'hands',
    label: 'Hands',
    icon: '👋',
    emojis: [
      ['👋', 'wave'], ['🤚', 'raised hand'], ['✋', 'high five'], ['🖖', 'vulcan'],
      ['👌', 'ok'], ['🤌', 'pinched fingers'], ['✌️', 'peace'], ['🤞', 'crossed fingers'],
      ['🫰', 'heart hands'], ['🤙', 'call me'], ['👆', 'point up'], ['👇', 'point down'],
      ['👈', 'point left'], ['👉', 'point right'], ['👍', 'thumbs up'], ['👎', 'thumbs down'],
      ['✊', 'fist'], ['👊', 'punch'], ['🤛', 'left fist'], ['🤜', 'right fist'],
      ['👏', 'clap'], ['🙌', 'raising hands'], ['🫶', 'heart hands'], ['🤝', 'handshake'],
      ['🙏', 'pray'], ['💪', 'muscle'], ['🫵', 'pointing at viewer'],
    ],
  },
] as const;

type EmojiEntry = readonly [string, string];

// ── Component ─────────────────────────────────────────────────────────────────

interface EmojiPickerProps {
  onSelect: (emoji: string) => void;
  onClose: () => void;
}

export function EmojiPicker({ onSelect, onClose }: EmojiPickerProps) {
  const [search, setSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState<string>(CATEGORIES[0].id);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const categoryRefs = useRef<Record<string, HTMLDivElement | null>>({});

  // Focus search on mount
  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // Close on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    // Delay listener to avoid closing immediately from the click that opened us
    const timer = setTimeout(() => document.addEventListener('mousedown', handleClick), 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClick);
    };
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  // Filter emojis by search
  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return null; // show categorized view
    const results: EmojiEntry[] = [];
    for (const cat of CATEGORIES) {
      for (const entry of cat.emojis) {
        if (entry[1].includes(q) || entry[0] === q) {
          results.push(entry);
        }
      }
    }
    return results;
  }, [search]);

  const scrollToCategory = (catId: string) => {
    setActiveCategory(catId);
    setSearch('');
    const el = categoryRefs.current[catId];
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const handleSelect = (emoji: string) => {
    onSelect(emoji);
    onClose();
  };

  const renderEmojiButton = (entry: EmojiEntry) => (
    <button
      key={entry[0] + entry[1]}
      type="button"
      onClick={() => handleSelect(entry[0])}
      className="w-8 h-8 flex items-center justify-center text-lg rounded hover:bg-surface-2 cursor-pointer transition-colors"
      title={entry[1]}
    >
      {entry[0]}
    </button>
  );

  return (
    <div
      ref={panelRef}
      className="w-72 bg-ctp-mantle border border-surface-2 rounded-xl shadow-xl flex flex-col overflow-hidden"
      style={{ maxHeight: 360 }}
    >
      {/* Search */}
      <div className="px-3 pt-3 pb-2">
        <input
          ref={searchRef}
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search emoji..."
          className="w-full bg-surface-0 border border-surface-2 rounded-lg px-2.5 py-1.5 text-xs text-ctp-text placeholder:text-ctp-overlay0 focus:outline-none focus:border-ctp-blue"
        />
      </div>

      {/* Category tabs */}
      {!filtered && (
        <div className="flex gap-0.5 px-2 pb-1.5">
          {CATEGORIES.map((cat) => (
            <button
              key={cat.id}
              type="button"
              onClick={() => scrollToCategory(cat.id)}
              className={`flex-1 text-center py-1 text-sm rounded transition-colors cursor-pointer ${
                activeCategory === cat.id
                  ? 'bg-surface-1 shadow-sm'
                  : 'hover:bg-surface-0'
              }`}
              title={cat.label}
            >
              {cat.icon}
            </button>
          ))}
        </div>
      )}

      {/* Emoji grid */}
      <div className="flex-1 overflow-y-auto px-2 pb-2 min-h-0">
        {filtered ? (
          // Search results
          filtered.length > 0 ? (
            <div className="flex flex-wrap gap-0.5 pt-1">
              {filtered.map(renderEmojiButton)}
            </div>
          ) : (
            <p className="text-center text-xs text-ctp-overlay0 py-6">No results</p>
          )
        ) : (
          // Categorized view
          CATEGORIES.map((cat) => (
            <div
              key={cat.id}
              ref={(el) => { categoryRefs.current[cat.id] = el; }}
            >
              <div className="text-[10px] font-semibold text-ctp-overlay0 uppercase tracking-wider pt-2 pb-1 px-0.5 sticky top-0 bg-ctp-mantle">
                {cat.label}
              </div>
              <div className="flex flex-wrap gap-0.5">
                {cat.emojis.map(renderEmojiButton)}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
