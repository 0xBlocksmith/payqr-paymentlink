"use client";

import { Nav } from "../../components/Nav";
import { DisputeList } from "../../components/DisputeButton";
import { useT } from "../../lib/i18n";

export default function Disputes() {
  const { t } = useT();
  return (
    <>
      <Nav back />
      <div className="screen">
        <h1 style={{ textAlign: "center", marginBottom: 14 }}>{t("nav.disputes")}</h1>
        <div className="dispute-picker">
          <DisputeList />
        </div>
      </div>
    </>
  );
}
