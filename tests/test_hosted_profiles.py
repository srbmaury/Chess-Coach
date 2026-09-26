import threading

import pytest
from hosted_factories import FakePlayerLookup, new_account, subscribe

from chess_ml_coach.hosted.profiles import (
    InvalidUsernameError,
    NotEntitledError,
    PaidSubscriptionRequiredError,
    ProfileLimitError,
    ProfileRepository,
    UnknownPlayerError,
    normalize_username,
)


def test_usernames_are_normalized_and_validated():
    assert normalize_username("  MagnusCarlsen ") == "magnuscarlsen"
    for bad in ("", "ab", "a" * 26, "bad name", "../etc"):
        with pytest.raises(InvalidUsernameError):
            normalize_username(bad)


def test_first_profile_is_free_and_claiming_it_again_is_idempotent(pg):
    account = new_account(pg)
    repository = ProfileRepository(pg, player_lookup=FakePlayerLookup())

    first = repository.claim(account, "MagnusCarlsen")
    again = repository.claim(account, "magnuscarlsen")

    assert first.slot_type == "free"
    assert again.id == first.id
    assert [profile.id for profile in repository.list(account)] == [first.id]


def test_two_accounts_share_one_player_identity(pg):
    lookup = FakePlayerLookup()
    repository = ProfileRepository(pg, player_lookup=lookup)

    first = repository.claim(new_account(pg), "magnuscarlsen")
    second = repository.claim(new_account(pg), "MAGNUSCARLSEN")

    assert first.player.id == second.player.id
    assert lookup.calls == ["magnuscarlsen"]


def test_renamed_chesscom_account_keeps_its_player(pg):
    lookup = FakePlayerLookup({"oldname": 77, "newname": 77})
    repository = ProfileRepository(pg, player_lookup=lookup)
    old = repository.claim(new_account(pg), "oldname")

    renamed = repository.claim(new_account(pg), "newname")

    assert renamed.player.id == old.player.id
    assert renamed.player.canonical_username == "newname"


def test_unknown_chesscom_player_is_rejected(pg):
    repository = ProfileRepository(pg, player_lookup=FakePlayerLookup({"someone": 1}))

    with pytest.raises(UnknownPlayerError):
        repository.claim(new_account(pg), "nobodyhere")


def test_second_profile_requires_an_entitling_subscription(pg):
    account = new_account(pg)
    repository = ProfileRepository(pg, player_lookup=FakePlayerLookup())
    repository.claim(account, "firstplayer")

    with pytest.raises(PaidSubscriptionRequiredError):
        repository.claim(account, "secondplayer")

    subscribe(pg, account, "trialing")
    assert repository.claim(account, "secondplayer").slot_type == "paid"


def test_five_paid_slots_then_rejection(pg):
    account = new_account(pg)
    subscribe(pg, account)
    repository = ProfileRepository(pg, player_lookup=FakePlayerLookup())
    repository.claim(account, "freeplayer")
    for index in range(5):
        assert repository.claim(account, f"paid{index}").slot_type == "paid"

    with pytest.raises(ProfileLimitError):
        repository.claim(account, "sixthpaid")
    assert len(repository.list(account)) == 6


def test_lapsed_paid_profiles_become_read_only(pg):
    account = new_account(pg)
    subscribe(pg, account)
    repository = ProfileRepository(pg, player_lookup=FakePlayerLookup())
    free = repository.claim(account, "freeplayer")
    paid = repository.claim(account, "paidplayer")
    with pg.transaction() as connection:
        connection.execute("UPDATE subscriptions SET status = 'canceled' WHERE account_id = %s", (account,))

    states = {profile.player.canonical_username: profile.state for profile in repository.list(account)}
    assert states == {"freeplayer": "active", "paidplayer": "read_only"}
    assert repository.require_entitled(account, free.player.id).id == free.player.id
    assert repository.require_entitled(account, paid.player.id, write=False).id == paid.player.id
    with pytest.raises(NotEntitledError):
        repository.require_entitled(account, paid.player.id)


def test_unrelated_account_is_not_entitled(pg):
    repository = ProfileRepository(pg, player_lookup=FakePlayerLookup())
    profile = repository.claim(new_account(pg), "magnuscarlsen")

    with pytest.raises(NotEntitledError):
        repository.require_entitled(new_account(pg), profile.player.id, write=False)


def test_concurrent_claims_never_exceed_the_paid_limit(pg):
    account = new_account(pg)
    subscribe(pg, account)
    repository = ProfileRepository(pg, player_lookup=FakePlayerLookup())
    repository.claim(account, "freeplayer")
    outcomes: list[str] = []

    def claim(index: int) -> None:
        try:
            repository.claim(account, f"racer{index}")
            outcomes.append("ok")
        except ProfileLimitError:
            outcomes.append("limit")

    threads = [threading.Thread(target=claim, args=(index,)) for index in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert outcomes.count("ok") == 5
    assert outcomes.count("limit") == 3


def test_record_manifest_ignores_an_older_build(pg):
    from datetime import UTC, datetime, timedelta

    repository = ProfileRepository(pg, player_lookup=FakePlayerLookup())
    player = repository.claim(new_account(pg), "magnuscarlsen").player
    now = datetime.now(UTC)

    newer = repository.record_manifest(
        player.id, manifest_hash="b" * 64, storage_key="new", game_count=2, built_at=now
    )
    older = repository.record_manifest(
        player.id,
        manifest_hash="a" * 64,
        storage_key="old",
        game_count=1,
        built_at=now - timedelta(minutes=1),
    )

    assert newer.latest_manifest_hash == "b" * 64
    assert older.latest_manifest_hash == "b" * 64
