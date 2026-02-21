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

const TextContent = styled.h1`
  font-size: clamp(1.5rem, 4vw, 2.5rem);
  font-weight: 600;
  color: #ffffff;
  animation: ${fadeIn} 0.75s ease-out;
  z-index: 2;
  text-align: center;
  max-width: 700px;
  line-height: 1.5;
  margin: 0 0 24px 0;

  @media (prefers-reduced-motion: reduce) {
    animation: none;
  }
`;

const StartButton = styled.button`
  font-size: clamp(1rem, 2vw, 1.25rem);
  font-weight: 600;
  color: #0a2b48;
  background: #ffffff;
  border: none;
  border-radius: 12px;
  padding: 14px 32px;
  cursor: pointer;
  z-index: 2;
  animation: ${fadeIn} 0.75s ease-out 0.15s both;
  transition: all 0.2s ease;
  font-family: inherit;

  &:hover {
    transform: translateY(-2px);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
  }

  &:active {
    transform: translateY(0);
  }

  &:focus-visible {
    outline: 2px solid rgba(255, 255, 255, 0.8);
    outline-offset: 2px;
  }

  @media (prefers-reduced-motion: reduce) {
    animation: none;

    &:hover {
      transform: none;
    }
  }
`;

export default function LandingPageStart() {
  const navigate = useNavigate();

  const handleStart = () => navigate(`/chatbot/playground/${uuidv4()}`);
  const handleBack = () => navigate("/about");

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowRight" || event.key === "Enter") handleStart();
      else if (event.key === "ArrowLeft") handleBack();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <PageContainer role="main">
      <TextContent>
        The more specific your questions, the better I can help you!
      </TextContent>
      <StartButton onClick={handleStart} aria-label="Start chatting with ABE">
        Get Started &rarr;
      </StartButton>
      <Circle className="darkBlue" aria-hidden="true" />
      <Circle className="lightBlue" aria-hidden="true" />
    </PageContainer>
  );
}
