param([Parameter(Mandatory=$true)][string]$Directory)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$full = [IO.Path]::GetFullPath($Directory)
if ($full -eq [IO.Path]::GetPathRoot($full)) { throw 'Cannot protect a drive root' }
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$sections = [Security.AccessControl.AccessControlSections]'Owner,Access'
$existing = [IO.Directory]::GetAccessControl($full, $sections)
$owner = $existing.GetOwner([Security.Principal.SecurityIdentifier])
$inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
$propagation = [Security.AccessControl.PropagationFlags]::None
$allow = [Security.AccessControl.AccessControlType]::Allow
$system = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
# Reapplying an identical inheritable DACL propagates through existing cache and
# conversation files. This can exceed the startup deadline on a populated home.
# Verify every ACE, including inheritance and owner; never skip an unsafe DACL.
$rules = @($existing.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
$protected = $existing.AreAccessRulesProtected -and $owner.Value -eq $sid.Value -and $rules.Count -eq 2
foreach ($identity in @($sid, $system)) {
  $matching = @($rules | Where-Object {
    $_.IdentityReference.Value -eq $identity.Value -and
    $_.AccessControlType -eq $allow -and
    $_.FileSystemRights -eq [Security.AccessControl.FileSystemRights]::FullControl -and
    $_.InheritanceFlags -eq $inheritance -and
    $_.PropagationFlags -eq $propagation -and
    -not $_.IsInherited
  })
  $protected = $protected -and $matching.Count -eq 1
}
if ($protected) { return }
$acl = New-Object Security.AccessControl.DirectorySecurity
# An owner implicitly has WRITE_DAC, but not necessarily WRITE_OWNER (for
# example a user-created folder on a data drive with inherited Modify rights).
# Do not request an owner write when the directory already belongs to this user.
if ($owner.Value -ne $sid.Value) { $acl.SetOwner($sid) }
$acl.SetAccessRuleProtection($true, $false)
$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', $inheritance, $propagation, $allow)))
$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($system, 'FullControl', $inheritance, $propagation, $allow)))
# Persist only the owner and DACL changed above. Set-Acl can also request SACL
# access on an existing protected directory, requiring SeSecurityPrivilege.
[IO.Directory]::SetAccessControl($full, $acl)
