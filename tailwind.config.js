const v = (n) => `rgb(var(--${n}) / <alpha-value>)`;

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        nav: v('nav'), primary: v('primary'), heading: v('heading'), cognac: v('cognac'),
        petrol: v('petrol'), 'petrol-fill': v('petrolfill'), pale: v('pale'), cream: v('cream'),
        ink: v('ink'), card: v('card'), muted: v('muted'), line: v('line'), danger: v('danger'), dot: v('dot'),
      },
      fontFamily: {
        display: ['"Plus Jakarta Sans"', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        sans: ['"Plus Jakarta Sans"', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
      },
      boxShadow: {
        soft: '0 1px 2px rgb(0 0 0 / .10), 0 6px 20px rgb(0 0 0 / .14)',
        lift: '0 12px 36px rgb(0 0 0 / .32)',
      },
    },
  },
};
