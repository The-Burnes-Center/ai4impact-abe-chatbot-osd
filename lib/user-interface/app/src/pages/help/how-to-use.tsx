import { useState } from "react";
import Typography from "@mui/material/Typography";
import Stack from "@mui/material/Stack";
import Paper from "@mui/material/Paper";
import Box from "@mui/material/Box";
import Tabs from "@mui/material/Tabs";
import Tab from "@mui/material/Tab";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemText from "@mui/material/ListItemText";
import Collapse from "@mui/material/Collapse";
import Divider from "@mui/material/Divider";
import Breadcrumbs from "@mui/material/Breadcrumbs";
import MuiLink from "@mui/material/Link";
import ExpandMore from "@mui/icons-material/ExpandMore";
import ExpandLess from "@mui/icons-material/ExpandLess";
import { Link as RouterLink } from "react-router-dom";
import { CHATBOT_NAME } from "../../common/constants";

const prompts = [
  { title: "Spell out acronyms", details: "Avoid using abbreviations. For example, instead of 'RFP,' use 'Request for Proposal'." },
  { title: "Be specific and concise", details: "Provide clear and precise questions to help ABE give accurate responses." },
  { title: "Use keywords", details: "Include important terms in your query, such as 'vendor' or 'contract'." },
  { title: "Ask one question at a time", details: "Breaking down complex questions ensures better answers." },
  { title: "Include relevant details", details: "Specify important context, like names, dates, or locations, to guide the chatbot's response." },
  { title: "Ask follow-up questions", details: "Build on previous responses by asking follow-ups to get further clarity or additional details." },
];

const sampleQuestions = [
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

function TipsTab() {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const toggle = (key: string) =>
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));

  return (
    <Stack spacing={3} sx={{ mt: 3 }}>
      <Paper sx={{ p: 3 }}>
        <Typography variant="body1" color="text.secondary" sx={{ lineHeight: 1.7 }}>
          Learn how to phrase your questions effectively and explore examples to guide
          your interactions for quick and accurate procurement assistance.
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
          {sampleQuestions.map((section, index) => (
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
                      <Typography variant="body2" color="text.secondary">{q}</Typography>
                    </li>
                  ))}
                </Stack>
              </Collapse>
              {index < sampleQuestions.length - 1 && <Divider />}
            </Box>
          ))}
        </List>
      </Paper>
    </Stack>
  );
}

function AboutTab() {
  return (
    <Stack spacing={3} sx={{ mt: 3 }}>
      <Paper sx={{ p: 3 }}>
        <Typography variant="h4" component="h2" gutterBottom>
          Assistive Buyer Engine
        </Typography>
        <Typography variant="body1" color="text.secondary">
          ABE is an AI-powered assistant designed for the Massachusetts Executive Office
          to provide guidance on state procurement processes. It uses advanced language
          models and a curated knowledge base of procurement documentation to help users
          find answers quickly and accurately.
        </Typography>
      </Paper>

      <Paper sx={{ p: 3 }}>
        <Typography variant="h4" component="h2" gutterBottom>
          How It Works
        </Typography>
        <Typography variant="body1" color="text.secondary">
          ABE uses Retrieval-Augmented Generation (RAG) to search through official
          procurement documents and provide contextually relevant answers. Source
          documents are linked with each response so you can verify the information.
        </Typography>
      </Paper>

      <Paper sx={{ p: 3 }}>
        <Typography variant="h4" component="h2" gutterBottom>
          Important Notes
        </Typography>
        <Typography variant="body1" color="text.secondary">
          ABE provides guidance based on available documentation. Always verify
          critical procurement decisions with official policies and consult with
          your procurement team for complex situations.
        </Typography>
      </Paper>
    </Stack>
  );
}

function SupportTab() {
  return (
    <Stack spacing={3} sx={{ mt: 3 }}>
      <Paper sx={{ p: 3 }}>
        <Typography variant="h4" component="h2" gutterBottom>
          Need Help?
        </Typography>
        <Typography variant="body1" color="text.secondary">
          If you encounter any issues or have questions about using ABE,
          please reach out to your system administrator or the ABE support team.
        </Typography>
      </Paper>

      <Paper sx={{ p: 3 }}>
        <Typography variant="h4" component="h2" gutterBottom>
          Reporting Issues
        </Typography>
        <Typography variant="body1" color="text.secondary">
          Use the thumbs-down feedback button on any response to report
          inaccurate or unhelpful answers. Your feedback helps improve ABE&apos;s
          accuracy over time.
        </Typography>
      </Paper>
    </Stack>
  );
}

export default function HelpPage() {
  const [tabIndex, setTabIndex] = useState(0);

  return (
    <Box role="main">
      <Breadcrumbs sx={{ mb: 2 }} aria-label="breadcrumb">
        <MuiLink component={RouterLink} to="/" underline="hover" color="inherit" sx={{ fontSize: "0.8125rem" }}>
          {CHATBOT_NAME}
        </MuiLink>
        <Typography color="text.primary" sx={{ fontSize: "0.8125rem" }}>
          Help & Guide
        </Typography>
      </Breadcrumbs>

      <Typography variant="h2" component="h1" gutterBottom>
        Help & Guide
      </Typography>

      <Tabs
        value={tabIndex}
        onChange={(_, v) => setTabIndex(v)}
        sx={{ borderBottom: 1, borderColor: "divider" }}
      >
        <Tab label="Tips & Questions" />
        <Tab label="About ABE" />
        <Tab label="Support" />
      </Tabs>

      {tabIndex === 0 && <TipsTab />}
      {tabIndex === 1 && <AboutTab />}
      {tabIndex === 2 && <SupportTab />}
    </Box>
  );
}
