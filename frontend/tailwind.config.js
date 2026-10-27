/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
      colors: {
        brand: {
          50: '#eef6ff',
          100: '#d9eaff',
          200: '#bcdaff',
          300: '#8ec3ff',
          400: '#59a1fb',
          500: '#1d6fd8',
          600: '#155bb5',
          700: '#124a91',
          800: '#103b72',
          900: '#0c2b52',
          950: '#081d38',
        },
      },
      boxShadow: {
        card: '0 1px 2px rgba(15, 23, 42, 0.04), 0 1px 3px rgba(15, 23, 42, 0.06)',
        pop: '0 10px 30px -10px rgba(15, 23, 42, 0.25)',
      },
      keyframes: {
        'slide-in': { from: { opacity: 0, transform: 'translateY(8px)' }, to: { opacity: 1, transform: 'none' } },
      },
      animation: { 'slide-in': 'slide-in 0.18s ease-out' },
    },
  },
  plugins: [],
};
