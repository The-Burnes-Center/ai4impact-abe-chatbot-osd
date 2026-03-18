import React, { useState } from "react";
import {
  Box,
  Link,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
} from "@mui/material";
import Typography from "@mui/material/Typography";
import AdminMarkdown from "./admin-markdown";

interface TruncatedTextCellProps {
  text: string;
  maxLength?: number;
  previewMaxHeight?: number;
}

export function TruncatedTextCell({
  text,
  maxLength = 50,
  previewMaxHeight = 88,
}: TruncatedTextCellProps) {
  const [showModal, setShowModal] = useState(false);
  const value = text || "";
  const isTruncated = value.length > maxLength;

  return (
    <>
      <Box>
        {value ? (
          <Box
            sx={{
              position: "relative",
              maxHeight: isTruncated ? previewMaxHeight : "none",
              overflow: "hidden",
            }}
          >
            <AdminMarkdown content={value} compact />
            {isTruncated && (
              <Box
                sx={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  bottom: 0,
                  height: 28,
                  background: (theme) =>
                    `linear-gradient(to bottom, rgba(255,255,255,0), ${theme.palette.background.paper})`,
                  pointerEvents: "none",
                }}
              />
            )}
          </Box>
        ) : (
          <Typography variant="body2" color="text.secondary">
            N/A
          </Typography>
        )}
        {isTruncated && (
          <Link
            component="button"
            variant="body2"
            onClick={() => setShowModal(true)}
            sx={{ mt: 0.5 }}
          >
            Show More
          </Link>
        )}
      </Box>
      <Dialog
        open={showModal}
        onClose={() => setShowModal(false)}
        maxWidth="md"
        fullWidth
        aria-labelledby="full-text-dialog-title"
      >
        <DialogTitle id="full-text-dialog-title">Full Text</DialogTitle>
        <DialogContent>
          <AdminMarkdown content={value} />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setShowModal(false)}>Close</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
