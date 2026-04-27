import Box from "@mui/material/Box";

interface SkipLinkProps {
  targetId?: string;
  label?: string;
}

export default function SkipLink({
  targetId = "main-content",
  label = "Skip to main content",
}: SkipLinkProps) {
  return (
    <Box
      component="a"
      href={`#${targetId}`}
      className="sr-only"
      sx={{
        position: "absolute",
        width: 1,
        height: 1,
        padding: 0,
        margin: -1,
        overflow: "hidden",
        clip: "rect(0,0,0,0)",
        whiteSpace: "nowrap",
        border: 0,
        "&:focus, &:focus-visible": {
          position: "fixed",
          top: 8,
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 9999,
          clip: "auto",
          width: "auto",
          height: "auto",
          overflow: "visible",
          whiteSpace: "normal",
          bgcolor: "primary.main",
          color: "#fff",
          px: 3,
          py: 1.5,
          borderRadius: 2,
          fontWeight: 600,
          fontSize: "0.875rem",
          textDecoration: "none",
          boxShadow: 4,
          outline: "3px solid #FFD500",
          outlineOffset: 2,
        },
      }}
    >
      {label}
    </Box>
  );
}
