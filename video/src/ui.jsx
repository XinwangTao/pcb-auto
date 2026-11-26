import React from 'react';

export const C = {
  bg: '#05070d',
  bg2: '#0a1020',
  ink: '#eef2ff',
  dim: '#8b98b8',
  faint: '#3a4560',
  accent: '#4db8ff',
  accent2: '#7c6bff',
  green: '#35e0a1',
  amber: '#ffc44d',
  line: 'rgba(120,160,255,0.16)',
};

/** 全屏网格 + 径向光晕背景，统一所有分镜的视觉底 */
export const Backdrop = ({
  hue = 'accent',
  grid = true,
  children,
  style = {},
}) => {
  const glow = hue === 'green' ? C.green : C.accent;
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: `radial-gradient(120% 80% at 50% 0%, ${C.bg2} 0%, ${C.bg} 60%)`,
        overflow: 'hidden',
        ...style,
      }}
    >
      {grid ? (
        <div
          style={{
            position: 'absolute',
            inset: -100,
            backgroundImage: `linear-gradient(${C.line} 1px, transparent 1px), linear-gradient(90deg, ${C.line} 1px, transparent 1px)`,
            backgroundSize: '60px 60px',
            opacity: 0.5,
            maskImage:
              'radial-gradient(70% 60% at 50% 40%, #000 30%, transparent 100%)',
            WebkitMaskImage:
              'radial-gradient(70% 60% at 50% 40%, #000 30%, transparent 100%)',
          }}
        />
      ) : null}
      <div
        style={{
          position: 'absolute',
          width: 1100,
          height: 1100,
          left: -10,
          top: -520,
          borderRadius: '50%',
          background: `radial-gradient(circle, ${glow}30 0%, transparent 62%)`,
          filter: 'blur(20px)',
        }}
      />
      {children}
    </div>
  );
};

export const Frame = ({ children, pad = 76 }) => (
  <div
    style={{
      position: 'absolute',
      inset: 0,
      padding: pad,
      display: 'flex',
      flexDirection: 'column',
      boxSizing: 'border-box',
    }}
  >
    {children}
  </div>
);

/** 分镜小标签，如 01 / 02 */
export const Chip = ({ children, color = C.accent, style = {} }) => (
  <div
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 14,
      padding: '12px 28px',
      borderRadius: 999,
      border: `2px solid ${color}55`,
      background: `${color}14`,
      color,
      fontSize: 30,
      fontWeight: 700,
      letterSpacing: 3,
      ...style,
    }}
  >
    {children}
  </div>
);

export const Divider = ({ style = {} }) => (
  <div
    style={{
      height: 2,
      width: '100%',
      background: `linear-gradient(90deg, transparent, ${C.accent}66, transparent)`,
      ...style,
    }}
  />
);
