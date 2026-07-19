"""@pyne edge"""

from pynecore import lib


def own_line():
    """
    @pyne
    """


def raw_prefix():
    r"""@pyne"""


def single_quoted():
    '@pyne'


def triple_single():
    '''@pyne edge'''


def not_at_start():
    """Docs that merely mention @pyne stay plain."""


def word_boundary():
    """@pynecore is not the marker."""


# @pyne in a plain comment stays plain
x = "@pyne in a normal string stays plain"
