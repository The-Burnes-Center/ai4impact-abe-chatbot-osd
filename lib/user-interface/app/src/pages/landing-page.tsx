import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { v4 as uuidv4 } from "uuid";
import styled, { keyframes } from "styled-components";

const fadeIn = keyframes`
  from { opacity: 0; transform: translateY(12px); }
  to { opacity: 1; transform: translateY(0); }
`;

const PageContainer = styled.div`
  position: relative;
  background: linear-gradient(135deg, #0a2b48 0%, #14558f 100%);
  width: 100vw;
  height: 100vh;
  box-sizing: border-box;
  padding: 24px clamp(20px, 5vw, 60px);
  font-family: "Inter", "Open Sans", "Helvetica Neue", sans-serif;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  overflow: hidden;
`;

const Circle = styled.div`
  position: absolute;
  border-radius: 50%;
  z-index: 0;

  &.darkBlue {
    background-color: rgba(10, 43, 72, 0.5);
    width: 160vw;
    height: 95vw;
    bottom: -100%;
    left: -93%;
    z-index: 1;
  }

  &.lightBlue {
    background-color: rgba(20, 85, 143, 0.4);
    width: 95vw;
    height: 50vw;
    bottom: -52%;
    right: -44%;
    z-index: 0;
  }
`;

const HeaderBar = styled.div`
  display: flex;
  justify-content: flex-end;
  align-items: center;
  width: 100%;
  position: absolute;
  top: 0;
  right: 0;
  padding: 20px 24px 0 0;
  z-index: 3;
`;

const SkipButton = styled.button`
  color: rgba(255, 255, 255, 0.9);
  font-size: 0.875rem;
  transition: all 0.2s ease;
  font-weight: 600;
  animation: ${fadeIn} 0.75s ease-out;
  background: none;
  border: 1px solid rgba(255, 255, 255, 0.3);
  border-radius: 8px;
  padding: 8px 16px;
  cursor: pointer;
  font-family: inherit;

  &:hover {
    background: rgba(255, 255, 255, 0.1);
    border-color: rgba(255, 255, 255, 0.5);
  }

  &:focus-visible {
    outline: 2px solid rgba(255, 255, 255, 0.8);
    outline-offset: 2px;
  }
`;

const Heading = styled.h1`
  font-size: clamp(2.5rem, 8vw, 5.5rem);
  font-weight: 700;
  color: #ffffff;
  animation: ${fadeIn} 0.75s ease-out;
  z-index: 2;
  text-align: center;
  margin: 0;
  line-height: 1.1;
  letter-spacing: -0.02em;

  @media (prefers-reduced-motion: reduce) {
    animation: none;
  }
`;

const SubText = styled.button`
  font-size: clamp(1rem, 2.5vw, 1.5rem);
  font-weight: 500;
  color: rgba(255, 255, 255, 0.85);
  margin-top: 16px;
  animation: ${fadeIn} 0.75s ease-out 0.15s both;
  z-index: 2;
  text-align: center;
  transition: all 0.2s ease;
  background: none;
  border: none;
  cursor: pointer;
  font-family: inherit;
  padding: 8px 16px;
  border-radius: 8px;

  &:hover {
    color: #ffffff;
    background: rgba(255, 255, 255, 0.1);
  }

  &:focus-visible {
    outline: 2px solid rgba(255, 255, 255, 0.8);
    outline-offset: 2px;
  }

  @media (prefers-reduced-motion: reduce) {
    animation: none;
  }
`;

export default function LandingPage() {
  const navigate = useNavigate();

  const handleSkip = () => navigate(`/chatbot/playground/${uuidv4()}`);
  const handleNext = () => navigate("/about");

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowRight") handleNext();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <PageContainer role="main">
      <HeaderBar>
        <SkipButton onClick={handleSkip} aria-label="Skip introduction and go to chat">
          Skip to Chat &rarr;
        </SkipButton>
      </HeaderBar>
      <Heading>Welcome to ABE</Heading>
      <SubText onClick={handleNext} aria-label="Learn more about ABE">
        Learn more about what I can do for you &rarr;
      </SubText>
      <Circle className="darkBlue" aria-hidden="true" />
      <Circle className="lightBlue" aria-hidden="true" />
    </PageContainer>
  );
}
