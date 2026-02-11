/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{ts,tsx,html}'],
  theme: {
    extend: {
      colors: {
        'ctp-base': '#1e1e2e',
        'ctp-mantle': '#181825',
        'ctp-crust': '#11111b',
        'ctp-text': '#cdd6f4',
        'ctp-subtext1': '#bac2de',
        'ctp-subtext0': '#a6adc8',
        'surface-0': '#313244',
        'surface-1': '#45475a',
        'surface-2': '#585b70',
      },
    },
  },
  plugins: [],
};
