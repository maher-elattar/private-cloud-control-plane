/**
 * Country flags as inline SVG.
 *
 * WHY not emoji: regional-indicator sequences (🇫🇮) have no glyph in the default font stack on
 * most Linux systems, where they degrade to the bare letters "FI". Inline SVG renders identically
 * everywhere and keeps the location pickers legible.
 */
import type { CountryCode } from '../data/types';

/** Renders a 4:3 flag at the given width. */
export function Flag({
  country,
  width = 20,
}: {
  readonly country: CountryCode;
  readonly width?: number;
}) {
  const height = Math.round((width * 3) / 4);
  const common = {
    width,
    height,
    viewBox: '0 0 4 3',
    role: 'img' as const,
    'aria-hidden': true,
    className: 'shrink-0 rounded-[1px]',
  };

  if (country === 'de') {
    return (
      <svg {...common}>
        <rect width="4" height="1" y="0" fill="#000" />
        <rect width="4" height="1" y="1" fill="#D00" />
        <rect width="4" height="1" y="2" fill="#FFCE00" />
      </svg>
    );
  }

  if (country === 'fi') {
    return (
      <svg {...common}>
        <rect width="4" height="3" fill="#fff" />
        <rect width="4" height="0.8" y="1.1" fill="#003580" />
        <rect width="0.8" height="3" x="1.05" fill="#003580" />
      </svg>
    );
  }

  if (country === 'sg') {
    return (
      <svg {...common}>
        <rect width="4" height="1.5" fill="#ED2939" />
        <rect width="4" height="1.5" y="1.5" fill="#fff" />
        <circle cx="0.95" cy="0.75" r="0.5" fill="#fff" />
        <circle cx="1.15" cy="0.75" r="0.45" fill="#ED2939" />
      </svg>
    );
  }

  return (
    <svg {...common}>
      <rect width="4" height="3" fill="#fff" />
      {[0, 1, 2, 3, 4, 5, 6].map((row) => (
        <rect key={row} width="4" height="0.2" y={row * 0.46} fill="#B22234" />
      ))}
      <rect width="1.7" height="1.6" fill="#3C3B6E" />
    </svg>
  );
}
