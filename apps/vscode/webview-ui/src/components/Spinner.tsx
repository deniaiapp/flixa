import { useEffect, useState } from 'react';

const FRAMES = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];

export function Spinner({ className = '' }: { className?: string }) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setFrame((prev) => (prev + 1) % FRAMES.length), 120);
    return () => clearInterval(id);
  }, []);

  return (
    <span
      aria-hidden="true"
      className={`inline-flex w-3.5 justify-center text-accent font-mono leading-none select-none ${className}`}
    >
      {FRAMES[frame]}
    </span>
  );
}
