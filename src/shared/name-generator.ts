const ADJECTIVES = [
  'swift', 'brave', 'calm', 'bold', 'keen', 'wise', 'fair', 'true', 'warm', 'cool',
  'wild', 'free', 'glad', 'kind', 'sure', 'rich', 'deep', 'soft', 'loud', 'bright',
  'quick', 'sharp', 'proud', 'steady', 'gentle', 'clever', 'mighty', 'nimble', 'vivid', 'noble',
  'jolly', 'merry', 'lucky', 'plucky', 'witty', 'crafty', 'daring', 'hardy', 'lively', 'snappy',
  'cosmic', 'lunar', 'solar', 'rustic', 'golden', 'silver', 'copper', 'crimson', 'azure', 'amber',
  'silent', 'patient', 'earnest', 'curious', 'fearless', 'graceful', 'honest', 'humble', 'playful', 'faithful',
  'radiant', 'serene', 'gallant', 'valiant', 'spirited', 'steadfast', 'cheerful', 'bubbly', 'dapper', 'zesty',
  'fluffy', 'fuzzy', 'peppy', 'perky', 'chirpy', 'bouncy', 'gritty', 'scrappy', 'zippy', 'snazzy',
  'stellar', 'epic', 'prime', 'ultra', 'mega', 'hyper', 'turbo', 'super', 'grand', 'royal',
  'ancient', 'mystic', 'arctic', 'tropic', 'alpine', 'coastal', 'desert', 'forest', 'meadow', 'summit',
];

const ANIMALS = [
  'leopard', 'falcon', 'otter', 'panda', 'wolf', 'eagle', 'fox', 'hawk', 'bear', 'lynx',
  'tiger', 'raven', 'crane', 'whale', 'cobra', 'bison', 'heron', 'koala', 'moose', 'viper',
  'badger', 'beaver', 'bobcat', 'condor', 'coyote', 'dolphin', 'ferret', 'gazelle', 'iguana', 'jackal',
  'marten', 'osprey', 'parrot', 'pelican', 'python', 'rabbit', 'salmon', 'toucan', 'walrus', 'wombat',
  'alpaca', 'cheetah', 'corgi', 'dingo', 'ermine', 'finch', 'gecko', 'hippo', 'ibis', 'jaguar',
  'lemur', 'mantis', 'newt', 'ocelot', 'puffin', 'quail', 'robin', 'sloth', 'stoat', 'swift',
  'tapir', 'urchin', 'vulture', 'weasel', 'xerus', 'yak', 'zebra', 'ant', 'bee', 'crow',
  'dove', 'elk', 'frog', 'goat', 'hare', 'kiwi', 'lark', 'moth', 'owl', 'ram',
  'seal', 'toad', 'wasp', 'wren', 'crab', 'deer', 'duck', 'gull', 'mink', 'mole',
  'pika', 'slug', 'snail', 'squid', 'stork', 'trout', 'boar', 'camel', 'egret', 'llama',
];

// Hub names — evocative places / spaces
const HUB_ADJECTIVES = [
  'peaceful', 'busy', 'bustling', 'ancient', 'astral', 'quiet', 'hidden', 'sunlit', 'moonlit', 'starlit',
  'misty', 'golden', 'silver', 'crystal', 'mossy', 'coral', 'amber', 'cobalt', 'ivory', 'jade',
  'dusty', 'lofty', 'cozy', 'rustic', 'coastal', 'alpine', 'twilight', 'velvet', 'copper', 'frozen',
  'verdant', 'marble', 'hollow', 'winding', 'shadowy', 'radiant', 'serene', 'vibrant', 'timeless', 'drifting',
];

const HUB_PLACES = [
  'meadow', 'market', 'depot', 'orchard', 'studio', 'harbor', 'garden', 'plaza', 'tower', 'grove',
  'canyon', 'summit', 'lagoon', 'terrace', 'chapel', 'bastion', 'citadel', 'forge', 'haven', 'oasis',
  'arcade', 'atrium', 'bridge', 'canopy', 'cellar', 'docks', 'gallery', 'gatehouse', 'landing', 'loft',
  'outpost', 'parlor', 'quarry', 'rampart', 'reef', 'sanctum', 'tavern', 'vault', 'wharf', 'workshop',
];

// Quick agent names — ephemeral / fleeting nature
const QUICK_ADJECTIVES = [
  'flash', 'spark', 'drift', 'wisp', 'flick', 'blink', 'glint', 'ghost', 'shadow', 'vapor',
  'breeze', 'ripple', 'flare', 'pulse', 'shimmer', 'fleeting', 'passing', 'transient', 'brief', 'swift',
  'instant', 'sudden', 'hasty', 'snappy', 'zippy', 'rapid', 'brisk', 'nimble', 'dash', 'streak',
];

const QUICK_NOUNS = [
  'comet', 'meteor', 'spark', 'ember', 'flame', 'gust', 'wave', 'bolt', 'ray', 'beam',
  'flash', 'blaze', 'frost', 'mist', 'haze', 'echo', 'pulse', 'whirl', 'drift', 'bloom',
  'flicker', 'glimmer', 'whisper', 'zephyr', 'aurora', 'mirage', 'nebula', 'photon', 'quark', 'nova',
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function generateDurableName(): string {
  return `${pick(ADJECTIVES)}-${pick(ANIMALS)}`;
}

export function generateHubName(): string {
  return `${pick(HUB_ADJECTIVES)}-${pick(HUB_PLACES)}`;
}

export function generateQuickName(): string {
  return `${pick(QUICK_ADJECTIVES)}-${pick(QUICK_NOUNS)}`;
}

export const AGENT_COLORS = [
  { id: 'indigo', label: 'Indigo', bg: 'bg-indigo-500', ring: 'ring-indigo-500', hex: '#6366f1' },
  { id: 'emerald', label: 'Emerald', bg: 'bg-emerald-500', ring: 'ring-emerald-500', hex: '#10b981' },
  { id: 'amber', label: 'Amber', bg: 'bg-amber-500', ring: 'ring-amber-500', hex: '#f59e0b' },
  { id: 'rose', label: 'Rose', bg: 'bg-rose-500', ring: 'ring-rose-500', hex: '#f43f5e' },
  { id: 'cyan', label: 'Cyan', bg: 'bg-cyan-500', ring: 'ring-cyan-500', hex: '#06b6d4' },
  { id: 'violet', label: 'Violet', bg: 'bg-violet-500', ring: 'ring-violet-500', hex: '#8b5cf6' },
  { id: 'orange', label: 'Orange', bg: 'bg-orange-500', ring: 'ring-orange-500', hex: '#f97316' },
  { id: 'teal', label: 'Teal', bg: 'bg-teal-500', ring: 'ring-teal-500', hex: '#14b8a6' },
] as const;

export type AgentColorId = typeof AGENT_COLORS[number]['id'];
