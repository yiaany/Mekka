import styles from "./loading-anim.module.css";

const LogoLoader = () => (
  <div className="w-full h-full flex flex-col items-center justify-center">
    <div>
      <svg
        width="60"
        height="62"
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className={styles["loading"]}
      >
        <path
          d="M4 25V7h5l7 9 7-9h5v18h-5V14l-7 9-7-9v11H4Z"
          stroke="hsl(var(--brand-default))"
          strokeWidth={2}
          strokeLinecap="round"
        />
      </svg>
    </div>
  </div>
);

export default LogoLoader;
