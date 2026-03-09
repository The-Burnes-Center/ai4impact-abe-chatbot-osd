import React, { useState } from "react";
import {
  Box,
  Typography,
  Link,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
} from "@mui/material";

export function TruncatedTextCell({ text, maxLength = 50 }) {
  const [showModal, setShowModal] = useState(false);

  const truncatedText =
    text.length > maxLength ? text.slice(0, maxLength) + "..." : text;

  return (
    <>
      <Box>
        <Typography variant="body2" component="span">
          {truncatedText}
        </Typography>
        {text.length > maxLength && (
          <Link
            component="button"
            variant="body2"
            onClick={() => setShowModal(true)}
            sx={{ ml: 0.5 }}
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
          <Typography variant="body2" sx={{ whiteSpace: "pre-wrap" }}>
            {text}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setShowModal(false)}>Close</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
