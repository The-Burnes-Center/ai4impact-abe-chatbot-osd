import React, { useEffect, useState } from "react";
import { Box, Link, Modal, TextContent } from "@cloudscape-design/components";

export function TruncatedTextCell({ text, maxLength = 50 }) {
  const [showModal, setShowModal] = useState(false);

  const handleShowMore = () => {
    setShowModal(true);
  };

  const handleClose = () => {
    setShowModal(false);
  };

  const truncatedText = text.length > maxLength ? text.slice(0, maxLength) + "..." : text;

  useEffect(() => {
    const interval = setInterval(() => {
      const dismissButtons = document.querySelectorAll('button.awsui_dismiss-control_1d2i7_11r6m_431');
  
      dismissButtons.forEach((button) => {
        if (!button.hasAttribute('aria-label')) {
          button.setAttribute('aria-label', 'Close modal');
        }
      });
  
      if (dismissButtons.length > 0) {
        clearInterval(interval);
      }
    }, 500); // check every 500ms
  
    return () => clearInterval(interval);
  }, []);
  
  return (
    <>
      <Box>
        <TextContent>{truncatedText}</TextContent>
        {text.length > maxLength && (
          <Link onFollow={handleShowMore}>Show More</Link>
        )}
      </Box>
      <Modal
        onDismiss={handleClose}
        visible={showModal}
        header="Full Text"
        footer={
          <Box float="right">
            <Link onFollow={handleClose}>Close</Link>
          </Box>
        }
      >
        <TextContent>{text}</TextContent>
      </Modal>
    </>
  );
}