import type { Metadata } from "next";
import LegalPage, { Points, Section } from "@/components/LegalPage";

export const metadata: Metadata = {
  title: "Terms | PlayBuddies",
  description:
    "The terms for using PlayBuddies. A free browser gaming site with original games, no purchases and no adverts.",
};

export default function TermsPage() {
  return (
    <LegalPage
      title="Terms"
      updated="21 August 2026"
      intro="Plain terms for a free site. Using PlayBuddies means you are happy with what is written here."
    >
      <Section title="It is free, and it stays free">
        <p>
          Every game on PlayBuddies is free to play in full. There is nothing to
          buy, no subscription, no premium tier and no adverts. No part of the
          site is held back behind a payment, and you will never be asked for
          card details, because there is nothing here to charge you for.
        </p>
      </Section>

      <Section title="Coins are just points">
        <p>
          Coins are earned by playing and are spent on cosmetic items inside the
          games. They are points and nothing more. They cannot be bought, sold,
          traded or converted into money, they have no cash value, and they carry
          no rights of any kind. If a game is rebalanced or rebuilt, coin
          balances may be reset.
        </p>
      </Section>

      <Section title="Your account">
        <p>
          You sign in with a Google account, so keeping that account secure is
          down to you and Google. You are responsible for what happens under your
          name here, including anything done in a lobby you host.
        </p>
      </Section>

      <Section title="Playing fair">
        <p>Keep it simple. While using PlayBuddies, do not:</p>
        <Points
          items={[
            "Harass, threaten or abuse other players.",
            "Pretend to be someone else, on the site or in a lobby.",
            "Tamper with the games, the database or other people's sessions.",
            "Try to break, overload or scrape the site.",
          ]}
        />
        <p>
          Accounts that do any of the above can lose access without notice. This
          is a small site run for fun and there is no appeals process.
        </p>
      </Section>

      <Section title="The games are original work">
        <p>
          Every game here was written from scratch for PlayBuddies. The code, the
          artwork, the sounds, the level layouts and the physics are all original
          work. No assets, no source code, no characters, no music and no artwork
          have been taken from any other game, and nothing here is a reskin,
          a clone or a repackaged copy of somebody else&apos;s project.
        </p>
        <p>
          The games do sit in familiar genres. A turn based artillery duel,
          arcade beach volleyball, a co-operative two element platformer and an
          eat or be eaten fish game are all long standing types of game that
          nobody owns, in the same way nobody owns racing games or platformers.
          Working within a genre is not copying, and everything that makes each
          of these games what it is was built here.
        </p>
        <p>
          PlayBuddies is not affiliated with, endorsed by, or connected to any
          other game, studio or publisher, and does not claim to be. Any
          resemblance in a game name or theme is genre convention rather than a
          suggestion of any link.
        </p>
        <p>
          If you own something and genuinely believe part of this site infringes
          it, get in touch and describe what and where. Anything that turns out
          to be a real problem will be changed or taken down promptly.
        </p>
      </Section>

      <Section title="Availability">
        <p>
          PlayBuddies is a hobby project. Games may be added, changed or removed,
          the site may go down without warning, and there is no promise that it
          will be running tomorrow. Do not build anything you depend on around
          it.
        </p>
      </Section>

      <Section title="No warranty">
        <p>
          The site is offered as it is, with no guarantee that it will work, that
          it will be free of bugs, or that your progress will survive. To the
          extent the law allows, PlayBuddies is not liable for anything that
          follows from using it, including lost progress or lost coins. Since it
          costs you nothing, that is the fair trade.
        </p>
      </Section>

      <Section title="Changes to these terms">
        <p>
          These terms can change. When they do, the date at the top changes with
          them, and carrying on using the site means the new version applies.
        </p>
      </Section>
    </LegalPage>
  );
}
