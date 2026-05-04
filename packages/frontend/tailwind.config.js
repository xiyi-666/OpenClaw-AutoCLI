/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // Dark theme (default)
        bg: {
          DEFAULT: '#0D0F0E',
          panel: '#141716',
        },
        border: {
          DEFAULT: '#2A2E2B',
        },
        accent: {
          DEFAULT: '#00FF87',
          warning: '#F5A623',
          danger: '#FF4545',
        },
        text: {
          DEFAULT: '#E8EDE9',
          muted: '#6B7A6E',
        },
        // Light theme
        'light-bg': {
          DEFAULT: '#F5F0E8',
          panel: '#EDEAE2',
        },
        'light-border': {
          DEFAULT: '#D9D4C8',
        },
        'light-accent': {
          DEFAULT: '#D97757',
          secondary: '#8B6F5E',
        },
        'light-text': {
          DEFAULT: '#1A1612',
          muted: '#7A6E65',
        },
      },
      fontFamily: {
        heading: ['"Space Mono"', 'monospace'],
        body: ['"IBM Plex Mono"', 'monospace'],
        number: ['Orbitron', 'monospace'],
      },
      spacing: {
        nav: '56px',
        header: '48px',
        list: '320px',
      },
    },
  },
  plugins: [],
};
