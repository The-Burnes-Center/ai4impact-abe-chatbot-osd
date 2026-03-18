import Box from "@mui/material/Box";
import { SxProps, Theme } from "@mui/material/styles";
import ReactMarkdown, { Components } from "react-markdown";
import remarkGfm from "remark-gfm";

interface AdminMarkdownProps {
  content?: string | null;
  compact?: boolean;
  maxHeight?: number | string;
  sx?: SxProps<Theme>;
}

const markdownComponents: Components = {
  a(props) {
    return <a {...props} target="_blank" rel="noopener noreferrer">{props.children}</a>;
  },
};

export default function AdminMarkdown({
  content,
  compact = false,
  maxHeight,
  sx,
}: AdminMarkdownProps) {
  const text = content ?? "";

  if (!text.trim()) {
    return null;
  }

  return (
    <Box
      sx={{
        fontSize: compact ? "0.8125rem" : "0.875rem",
        lineHeight: compact ? 1.6 : 1.75,
        color: "text.primary",
        wordBreak: "break-word",
        overflowX: "auto",
        ...(maxHeight ? { maxHeight, overflowY: "auto" } : {}),
        "& p": {
          my: compact ? 0.5 : 0.75,
        },
        "& p:first-of-type": {
          mt: 0,
        },
        "& p:last-of-type": {
          mb: 0,
        },
        "& ul, & ol": {
          my: compact ? 0.5 : 0.75,
          pl: 3,
        },
        "& li + li": {
          mt: 0.35,
        },
        "& blockquote": {
          m: 0,
          my: compact ? 0.75 : 1,
          pl: 1.5,
          borderLeft: "3px solid",
          borderColor: "divider",
          color: "text.secondary",
        },
        "& pre": {
          my: compact ? 0.75 : 1,
          p: 1.5,
          borderRadius: 1,
          bgcolor: "grey.100",
          overflow: "auto",
        },
        "& code": {
          fontFamily: "monospace",
          fontSize: "0.8125rem",
          bgcolor: "action.hover",
          px: 0.5,
          py: 0.125,
          borderRadius: 0.5,
        },
        "& pre code": {
          px: 0,
          py: 0,
          bgcolor: "transparent",
        },
        "& table": {
          width: "100%",
          my: compact ? 0.75 : 1,
          borderCollapse: "collapse",
        },
        "& th, & td": {
          border: "1px solid",
          borderColor: "divider",
          px: 1,
          py: 0.75,
          textAlign: "left",
          verticalAlign: "top",
        },
        "& th": {
          bgcolor: "grey.100",
          fontWeight: 600,
        },
        "& a": {
          color: "primary.main",
          textDecoration: "underline",
        },
        "& hr": {
          border: 0,
          borderTop: "1px solid",
          borderColor: "divider",
          my: compact ? 0.75 : 1,
        },
        "& h1, & h2, & h3, & h4": {
          mt: compact ? 0.75 : 1,
          mb: 0.5,
          lineHeight: 1.3,
        },
        "& h1": { fontSize: "1.1rem" },
        "& h2": { fontSize: "1rem" },
        "& h3, & h4": { fontSize: "0.95rem" },
      }}
    >
      <Box sx={sx}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
          {text}
        </ReactMarkdown>
      </Box>
    </Box>
  );
}
