/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{ts,tsx,html}'],
  theme: {
    extend: {
      colors: {
        'ctp-base': 'rgb(var(--ctp-base) / <alpha-value>)',
        'ctp-mantle': 'rgb(var(--ctp-mantle) / <alpha-value>)',
        'ctp-crust': 'rgb(var(--ctp-crust) / <alpha-value>)',
        'ctp-text': 'rgb(var(--ctp-text) / <alpha-value>)',
        'ctp-subtext1': 'rgb(var(--ctp-subtext1) / <alpha-value>)',
        'ctp-subtext0': 'rgb(var(--ctp-subtext0) / <alpha-value>)',
        'surface-0': 'rgb(var(--ctp-surface0) / <alpha-value>)',
        'surface-1': 'rgb(var(--ctp-surface1) / <alpha-value>)',
        'surface-2': 'rgb(var(--ctp-surface2) / <alpha-value>)',
      },
    },
  },
  plugins: [],
};
