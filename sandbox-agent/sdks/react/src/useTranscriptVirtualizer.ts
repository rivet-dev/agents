"use client";

import type { RefObject } from "react";
import { useEffect, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

export function useTranscriptVirtualizer<T>(items: T[], scrollElementRef?: RefObject<HTMLDivElement | null>, onAtBottomChange?: (atBottom: boolean) => void) {
  const isFollowingRef = useRef(true);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollElementRef?.current ?? null,
    estimateSize: () => 80,
    measureElement: (element) => element.getBoundingClientRect().height,
    overscan: 10,
  });

  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => isFollowingRef.current;

  useEffect(() => {
    const scrollElement = scrollElementRef?.current;
    if (!scrollElement) {
      return;
    }

    const updateFollowState = () => {
      const atBottom = scrollElement.scrollHeight - scrollElement.scrollTop - scrollElement.clientHeight < 50;
      isFollowingRef.current = atBottom;
      onAtBottomChange?.(atBottom);
    };

    updateFollowState();
    scrollElement.addEventListener("scroll", updateFollowState, { passive: true });

    return () => {
      scrollElement.removeEventListener("scroll", updateFollowState);
    };
  }, [onAtBottomChange, scrollElementRef]);

  useEffect(() => {
    if (!isFollowingRef.current || items.length === 0) {
      return;
    }

    const frameId = requestAnimationFrame(() => {
      virtualizer.scrollToIndex(items.length - 1, {
        align: "end",
        behavior: "smooth",
      });
    });

    return () => {
      cancelAnimationFrame(frameId);
    };
  }, [items.length, virtualizer]);

  return { virtualizer, isFollowingRef };
}
