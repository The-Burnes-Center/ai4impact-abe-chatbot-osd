import { useState } from "react";
import Typography from "@mui/material/Typography";
import Stack from "@mui/material/Stack";
import Paper from "@mui/material/Paper";
import Box from "@mui/material/Box";
import Breadcrumbs from "@mui/material/Breadcrumbs";
import MuiLink from "@mui/material/Link";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemText from "@mui/material/ListItemText";
import Collapse from "@mui/material/Collapse";
import Divider from "@mui/material/Divider";
import ExpandMore from "@mui/icons-material/ExpandMore";
import ExpandLess from "@mui/icons-material/ExpandLess";
import { Link as RouterLink } from "react-router-dom";
import { CHATBOT_NAME } from "../common/constants";

const prompts = [
  { title: "Spell out acronyms", details: "Avoid using abbreviations. For example, instead of 'RFP,' use 'Request for Proposal'." },
  { title: "Be specific and concise", details: "Provide clear and precise questions to help ABE give accurate responses." },
  { title: "Use keywords", details: "Include important terms in your query, such as 'vendor' or 'contract'." },
  { title: "Ask one question at a time", details: "Breaking down complex questions ensures better answers." },
  { title: "Include relevant details", details: "Specify important context, like names, dates, or locations, to guide the chatbot's response." },
  { title: "Ask follow-up questions", details: "Build on previous responses by asking follow-ups to get further clarity or additional details." },
];

const questions = [
  {
    topic: "General Procurement Questions",
    items: [
      "How can I get started with the procurement process?",
      "What is large procurement?",
      "What is the difference between an RFP and an RFQ?",
      "What are statewide contracts, and how do they work?",
    ],
  },
  {
    topic: "Contracts and Vendors",
    items: [
      "What contracts are available for [some product or service]?",
      "Where can I find a list of all vendors on this contract?",
      "Where is the price list for a certain contract?",
      "Can my agency use this contract?",
      "How can I check if this company is a small business?",
    ],
  },
  {
    topic: "Training and Resources",
    items: [
      "Where can I download the best value procurement handbook?",
      "Where can I locate job aids for executive agency buyers?",
      "What training or resources are available for new buyers?",
    ],
  },
];

export default function TipsAndQuestions() {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const toggle = (key: string) => {
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  return (
    <Box role="main">
      <Breadcrumbs sx={{ mb: 2 }} aria-label="breadcrumb">
        <MuiLink component={RouterLink} to="/" underline="hover" color="inherit" sx={{ fontSize: "0.8125rem" }}>
          {CHATBOT_NAME}
        </MuiLink>
        <Typography color="text.primary" sx={{ fontSize: "0.8125rem" }}>
          Getting Started
        </Typography>
      </Breadcrumbs>

      <Typography variant="h2" component="h1" gutterBottom>
        Getting Started
      </Typography>

      <Stack spacing={3}>
        <Paper sx={{ p: 3 }}>
          <Typography variant="body1" color="text.secondary" sx={{ lineHeight: 1.7 }}>
            This page provides tips and sample questions to help you get the most out of ABE.
            Learn how to phrase your questions effectively and explore examples to guide your
            interactions for quick and accurate procurement assistance.
          </Typography>
        </Paper>

        <Paper sx={{ p: 3 }}>
          <Typography variant="h4" component="h2" sx={{ mb: 2 }}>
            Prompting Tips
          </Typography>
          <Divider />
          <List disablePadding>
            {prompts.map((prompt, index) => (
              <Box key={index}>
                <ListItemButton
                  onClick={() => toggle(`prompt-${index}`)}
                  aria-expanded={!!expanded[`prompt-${index}`]}
                  sx={{ px: 0.5, borderRadius: 1 }}
                >
                  {expanded[`prompt-${index}`] ? <ExpandLess sx={{ mr: 1 }} /> : <ExpandMore sx={{ mr: 1 }} />}
                  <ListItemText
                    primary={prompt.title}
                    primaryTypographyProps={{ fontWeight: 600, fontSize: "0.9375rem" }}
                  />
                </ListItemButton>
                <Collapse in={!!expanded[`prompt-${index}`]} timeout={200}>
                  <Typography variant="body2" color="text.secondary" sx={{ pl: 4.5, pb: 1.5 }}>
                    {prompt.details}
                  </Typography>
                </Collapse>
                {index < prompts.length - 1 && <Divider />}
              </Box>
            ))}
          </List>
        </Paper>

        <Paper sx={{ p: 3 }}>
          <Typography variant="h4" component="h2" sx={{ mb: 2 }}>
            Sample Questions
          </Typography>
          <Divider />
          <List disablePadding>
            {questions.map((section, index) => (
              <Box key={index}>
                <ListItemButton
                  onClick={() => toggle(`question-${index}`)}
                  aria-expanded={!!expanded[`question-${index}`]}
                  sx={{ px: 0.5, borderRadius: 1 }}
                >
                  {expanded[`question-${index}`] ? <ExpandLess sx={{ mr: 1 }} /> : <ExpandMore sx={{ mr: 1 }} />}
                  <ListItemText
                    primary={section.topic}
                    primaryTypographyProps={{ fontWeight: 600, fontSize: "0.9375rem" }}
                  />
                </ListItemButton>
                <Collapse in={!!expanded[`question-${index}`]} timeout={200}>
                  <Stack component="ul" spacing={0.5} sx={{ pl: 4.5, pb: 1.5, m: 0, listStyle: "disc" }}>
                    {section.items.map((q, qIndex) => (
                      <li key={qIndex}>
                        <Typography variant="body2" color="text.secondary">
                          {q}
                        </Typography>
                      </li>
                    ))}
                  </Stack>
                </Collapse>
                {index < questions.length - 1 && <Divider />}
              </Box>
            ))}
          </List>
        </Paper>
      </Stack>
    </Box>
  );
}
