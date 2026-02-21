import React, { useRef, useState } from 'react';
import { useEffect } from 'react';
import Box from "@mui/material/Box";
import Grid from "@mui/material/Grid";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import Accordion from "@mui/material/Accordion";
import AccordionSummary from "@mui/material/AccordionSummary";
import AccordionDetails from "@mui/material/AccordionDetails";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import { Auth } from 'aws-amplify';
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import styles from "../styles/chat.module.scss";

export interface FeedbackPanelProps {
  selectedFeedback: any;
}

export default function EmailPanel(props: FeedbackPanelProps) {

  useEffect(() => {
    console.log(props.selectedFeedback)
  }, [props.selectedFeedback]);

  return (
    <div>
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography variant="h6" sx={{ mb: 2 }}>Selected Feedback</Typography>
        <Grid container spacing={2}>
          <Grid item xs={12} md={6}>
            <Stack spacing={2}>
              <Paper variant="outlined" sx={{ p: 2 }}>
                <Typography variant="subtitle1" fontWeight="bold" sx={{ mb: 1 }}>
                  User Prompt
                </Typography>
                {props.selectedFeedback.UserPrompt ? props.selectedFeedback.UserPrompt : "No feedback selected"}
              </Paper>

              <Paper variant="outlined" sx={{ p: 2 }}>
                <Typography variant="subtitle1" fontWeight="bold" sx={{ mb: 1 }}>
                  User Comments
                </Typography>
                {props.selectedFeedback.FeedbackComments ? props.selectedFeedback.FeedbackComments : "No feedback selected"}
              </Paper>
            </Stack>
          </Grid>
          <Grid item xs={12} md={6}>
            <Paper variant="outlined" sx={{ p: 2 }}>
              <Typography variant="subtitle1" fontWeight="bold" sx={{ mb: 1 }}>
                Chatbot Response
              </Typography>
              {props.selectedFeedback.ChatbotMessage ? props.selectedFeedback.ChatbotMessage : "No feedback selected"}
              {props.selectedFeedback.Sources ? (
                <Accordion sx={{ mt: 2 }}>
                  <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                    <Typography>Sources</Typography>
                  </AccordionSummary>
                  <AccordionDetails>
                    <Grid container spacing={2}>
                      <Grid item xs={6}>
                        <Stack spacing={1}>
                          <Typography variant="subtitle2" fontWeight="bold">
                            Title
                          </Typography>
                          {(JSON.parse(props.selectedFeedback.Sources) as any[]).map((item, idx) => (
                            <Typography key={idx} variant="body2">{item.title}</Typography>
                          ))}
                        </Stack>
                      </Grid>
                      <Grid item xs={6}>
                        <Stack spacing={1}>
                          <Typography variant="subtitle2" fontWeight="bold">
                            URL
                          </Typography>
                        </Stack>
                      </Grid>
                    </Grid>
                  </AccordionDetails>
                </Accordion>
              ) : "No feedback selected"}
            </Paper>
          </Grid>
        </Grid>
      </Paper>
    </div>
  );
}
