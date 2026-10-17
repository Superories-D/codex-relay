param([Parameter(Mandatory=$true)][string]$Directory)
$ErrorActionPreference = 'Stop'
$full = [IO.Path]::GetFullPath($Directory)
if ($full -eq [IO.Path]::GetPathRoot($full)) { throw 'Cannot protect a drive root' }
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = New-Object Security.AccessControl.DirectorySecurity
# An owner implicitly has WRITE_DAC, but not necessarily WRITE_OWNER (for
# example a user-created folder on a data drive with inherited Modify rights).
# Do not request an owner write when the directory already belongs to this user.
$owner = ([IO.Directory]::GetAccessControl($full, [Security.AccessControl.AccessControlSections]::Owner)).GetOwner([Security.Principal.SecurityIdentifier])
if ($owner.Value -ne $sid.Value) { $acl.SetOwner($sid) }
$acl.SetAccessRuleProtection($true, $false)
$inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
$propagation = [Security.AccessControl.PropagationFlags]::None
$allow = [Security.AccessControl.AccessControlType]::Allow
$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', $inheritance, $propagation, $allow)))
$system = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($system, 'FullControl', $inheritance, $propagation, $allow)))
# Persist only the owner and DACL changed above. Set-Acl can also request SACL
# access on an existing protected directory, requiring SeSecurityPrivilege.
[IO.Directory]::SetAccessControl($full, $acl)
