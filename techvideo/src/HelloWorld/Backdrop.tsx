import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

// A custom animated backdrop: a rotating ring + two drifting gradient blobs.
// Purely decorative, sits behind the content so the composition reads as a
// clean, tech-style title card.
export const Backdrop: React.FC<{
  color1: string;
  color2: string;
  bg?: string;
}> = ({ color1, color2, bg }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  // Ring: spring scale-in, then continuous rotation.
  const ringScale = spring({
    frame,
    fps,
    config: { damping: 12, mass: 0.8 },
  });
  const ringRotation = interpolate(frame, [0, durationInFrames], [0, 360]);

  // Blob 1 drifts vertically + sways horizontally.
  const blob1Y = interpolate(frame, [0, durationInFrames], [140, -140], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const blob1X = Math.sin(frame / 18) * 70;

  // Blob 2 drifts the opposite way.
  const blob2Y = interpolate(frame, [0, durationInFrames], [-120, 160], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const blob2X = Math.cos(frame / 24) * 90;

  // Gentle pulse on the ring opacity.
  const ringPulse = interpolate(Math.sin(frame / 12), [-1, 1], [0.18, 0.34]);

  return (
    <AbsoluteFill style={{ backgroundColor: bg ?? "#000000", overflow: "hidden" }}>
      {/* Rotating ring */}
      <AbsoluteFill
        style={{
          justifyContent: "center",
          alignItems: "center",
          transform: `scale(${ringScale}) rotate(${ringRotation}deg)`,
        }}
      >
        <div
          style={{
            width: 540,
            height: 540,
            borderRadius: "50%",
            border: `6px solid ${color1}`,
            opacity: ringPulse,
          }}
        />
      </AbsoluteFill>
      {/* Floating blob 1 */}
      <AbsoluteFill
        style={{
          justifyContent: "center",
          alignItems: "center",
          transform: `translate(${blob1X}px, ${blob1Y}px) scale(0.473)`,
        }}
      >
        <div
          style={{
            width: 340,
            height: 340,
            borderRadius: "50%",
            background: color1,
            opacity: 0.18,
            filter: "blur(24px)",
          }}
        />
      </AbsoluteFill>
      {/* Floating blob 2 */}
      <AbsoluteFill
        style={{
          justifyContent: "center",
          alignItems: "center",
          transform: `translate(${blob2X}px, ${blob2Y}px) scale(0.6)`,
        }}
      >
        <div
          style={{
            width: 300,
            height: 300,
            borderRadius: "50%",
            background: color2,
            opacity: 0.2,
            filter: "blur(28px)",
          }}
        />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
