import { useEffect, useRef, useState } from "react";

/**
 * Fades its children up the first time they scroll into view. Without IntersectionObserver (or with reduced motion, see landing.css)
 * the content is simply shown, so nothing is ever left invisible.
 */
export default function Reveal({ as: Tag = "div", delay = 0, className = "", children, ...rest }) {
  const ref = useRef(null);
  const [shown, setShown] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const el = ref.current;
    if (!el || shown) return undefined;
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setShown(true); io.disconnect(); } }, { rootMargin: "0px 0px -8% 0px", threshold: 0.05 });
    io.observe(el);
    return () => io.disconnect();
  }, [shown]);
  return <Tag ref={ref} className={`rv${shown ? " in" : ""} ${className}`.trim()} style={delay ? { transitionDelay: `${delay}ms` } : undefined} {...rest}>{children}</Tag>;
}
