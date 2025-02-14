// export function el(tagName: string, className?: string) {
//   const e = document.createElement(tagName);
//   if (className) {
//     e.classList.add(className);
//   }
//   return e;
// }

type Attributes = "class" | "text" | "id" | "role" | "aria-label";

export function el(
  tagName: string,
  attributes: Partial<Record<Attributes, string>>,
  children: HTMLElement[] = []
) {
  const e = document.createElement(tagName);
  Object.entries(attributes).forEach(([k, v]) => {
    if (k === "text") {
      e.innerText = v;
      return;
    }
    e.setAttribute(k, v);
  });
  children.forEach((c) => e.appendChild(c));
  return e;
}
