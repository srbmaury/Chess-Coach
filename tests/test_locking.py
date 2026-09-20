from __future__ import annotations

import os

import pytest

from chess_ml_coach.locking import ProfileBusyError, exclusive_profile_lock


def _error_message(path):
    return f"busy: {path}"


def test_lock_is_released_after_use(tmp_path):
    lock_path = tmp_path / "profile.lock"
    with exclusive_profile_lock(lock_path, error_message=_error_message):
        assert lock_path.exists()
    assert not lock_path.exists()


def test_stale_lock_from_a_dead_pid_is_reclaimed(tmp_path):
    lock_path = tmp_path / "profile.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    # Simulate a crashed process: a lock file left behind, naming a pid that
    # is guaranteed not to be running.
    dead_pid = 2**30
    lock_path.write_text(str(dead_pid), encoding="utf-8")

    with exclusive_profile_lock(lock_path, error_message=_error_message):
        assert lock_path.read_text(encoding="utf-8") == str(os.getpid())
    assert not lock_path.exists()


def test_lock_held_by_a_live_process_still_raises(tmp_path):
    lock_path = tmp_path / "profile.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    # The current test process is very much alive.
    lock_path.write_text(str(os.getpid()), encoding="utf-8")

    with pytest.raises(ProfileBusyError), exclusive_profile_lock(
        lock_path, error_message=_error_message
    ):
        pass
    assert lock_path.exists()


def test_lock_with_unreadable_contents_is_left_alone(tmp_path):
    # We can't prove an unparsable lock is dead, so it's treated as busy
    # rather than silently reclaimed.
    lock_path = tmp_path / "profile.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    lock_path.write_text("", encoding="utf-8")

    with pytest.raises(ProfileBusyError), exclusive_profile_lock(
        lock_path, error_message=_error_message
    ):
        pass
    assert lock_path.exists()
