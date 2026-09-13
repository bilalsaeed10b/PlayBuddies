import type { Metadata } from "next";
import LegalPage, { Points, Section } from "@/components/LegalPage";

export const metadata: Metadata = {
  title: "Privacy | PlayBuddies",
  description:
    "What PlayBuddies stores, why it stores it, and everything it deliberately does not collect. No ads, no trackers, no analytics.",
};

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy"
      updated="11 September 2026"
      intro="PlayBuddies is a free hobby project. It is not funded by advertising and it does not make money from anyone who visits, so there is no reason for it to gather anything about you beyond what it takes to sign you in and put you in a room with your friends."
    >
      <Section title="The short version">
        <p>
          There are no adverts on this site. There are no analytics scripts, no
          tracking pixels and no third party trackers of any kind. Nothing about
          you is sold, rented, shared with advertisers or handed to a data
          broker. Nobody is profiling you here.
        </p>
        <p>
          The only information the site holds is the small amount it genuinely
          needs to work, and that is listed in full below.
        </p>
      </Section>

      <Section title="What is stored, and why">
        <Points
          items={[
            <>
              <strong className="text-white">Your Google account details.</strong>{" "}
              Signing in with Google gives the site your name, your profile
              picture, your email address and an account ID. The name and
              picture are what your friends see in a lobby. The email address is
              only ever visible to you and is used to tell one account from
              another.
            </>,
            <>
              <strong className="text-white">A friend code.</strong> An
              eight character code the site generates for you so friends can add
              you without needing your email address.
            </>,
            <>
              <strong className="text-white">Your friends list.</strong> Who you
              have added and who has added you, so the friends panel has
              something to show.
            </>,
            <>
              <strong className="text-white">Lobby membership.</strong> While you
              are in a room, the room knows you are in it and which game is
              selected. Expired rooms cannot be reused. Room records and their
              messages may remain stored until they are deleted.
            </>,
            <>
              <strong className="text-white">Online presence.</strong> Each open
              tab has its own connection marker, so friends can see who is around.
              A marker is removed when the service detects that connection has closed.
            </>,
            <>
              <strong className="text-white">Games played and games won.</strong>{" "}
              Two counters, so the dashboard has numbers on it.
            </>,
            <>
              <strong className="text-white">Lobby chat and invitations.</strong>{" "}
              Chat messages include your name, account ID, message and sending time.
              Invitations store the sender, recipient, room and expiry time.
            </>,
            <>
              <strong className="text-white">Coins and unlocked items.</strong>{" "}
              The in-game currency you earn and the cosmetic items you have
              bought with it.
            </>,
          ]}
        />
        <p>
          All of this lives in Google Firebase, which handles the sign-in,
          the database and the presence flags. Google processes it as part of
          providing that service and their own privacy terms apply to it.
        </p>
      </Section>

      <Section title="What is never collected">
        <Points
          items={[
            "Advertising identifiers, tracking cookies or fingerprinting of any kind.",
            "Analytics. No page view counts, no session recordings, no heatmaps, no visitor statistics.",
            "Your location, your contacts, your browsing history or anything else on your device.",
            "Payment details. Nothing on PlayBuddies is for sale, so there is nothing to pay with.",
            "A PlayBuddies account record for visitors who never sign in. Hosting providers may process ordinary request and connection logs.",
          ]}
        />
      </Section>

      <Section title="Things kept in your own browser">
        <p>
          Your browser stores settings such as volume and the last room you visited.
          Standalone games store their coins and unlocks locally. When playing
          through a signed-in lobby, coins and unlocks are saved to your Firebase
          account so they can be loaded on another device. Clearing browser data
          removes local values; it does not delete your account data.
        </p>
      </Section>

      <Section title="Getting rid of your data">
        <p>
          Signing out ends this browser session and removes its presence connections
          when the service detects the disconnect. Other open sessions may remain online.
          Signing out does not delete your account, chat messages or game progress.
          Account deletion is a manual request; the site has no automatic deletion
          flow or guaranteed immediate deletion period.
        </p>
      </Section>

      <Section title="Children">
        <p>
          PlayBuddies is suitable for all ages and does not show adverts or ask
          for personal details beyond the Google sign-in. It is not aimed
          specifically at children and does not knowingly build profiles of
          anyone, of any age.
        </p>
      </Section>

      <Section title="Changes to this page">
        <p>
          If what the site stores ever changes, this page changes with it and the
          date at the top is updated. Nothing here will quietly start collecting
          more than it says.
        </p>
      </Section>
    </LegalPage>
  );
}
